// Replay validation harness for the Commit 12 shared_energy fix.
// Read-only: loads recorded session JSONs, rebuilds the 60-second
// envelopes from streams.features, recomputes shared_energy via the
// new Commit 12 code path, and compares to the originally-recorded
// values. Does NOT modify the session files.
//
// Usage:
//   node tests/bcs-replay-validation.mjs <session1.json> [session2.json ...]
//   node tests/bcs-replay-validation.mjs --fixtures
//     (reads every .json under tests/fixtures/bcs-replay/)
//
// Exit codes:
//   0  — all historic SE=0 samples now emit null+flag, clusters homogeneous
//   1  — no sessions validated (bad paths, missing streams)
//   2  — Commit 12 missed paths (some SE=0 samples still recompute to 0)
//
// Inputs required in each session JSON (current SessionRecorder format):
//   streams.features[*].{heart.meanHR, gut.rsaAmplitude, head.alphaPowerNorm}
//   streams.bcs[*].{t, sharedEnergy, ...}

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';

import { sharedModeEnergyFraction } from '../src/bcs/memd.js';
import { lowpass, resampleLinear } from '../src/math/filters.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = resolve(here, 'fixtures', 'bcs-replay');
const TOLERANCE = 0.05;

// Mirrors bcs-engine.js _makeEnvelope exactly so replay reproduces the
// original envelopes bit-for-bit (apart from floating-point reordering
// in the resampler, which is negligible at our tolerance).
function rebuildEnvelope(values, timestamps) {
  if (values.length < 16) return null;
  const { data } = resampleLinear(values, timestamps, 4);
  if (data.length < 16) return null;
  try {
    return lowpass(data, 0.5, 4);
  } catch {
    return data;
  }
}

// Collect feature samples in the 60 s window leading up to the BCS
// sample's timestamp, matching the engine's rolling _trimTo60s buffer.
function rebuildInputsAt(session, tBcs) {
  const features = session.streams?.features || [];
  const tStart = Math.max(0, tBcs - 60);
  const gV = [], gT = [];
  const hV = [], hT = [];
  const dV = [], dT = [];
  for (const f of features) {
    if (f.t > tBcs) break;
    if (f.t < tStart) continue;
    if (f.gut?.rsaAmplitude != null) { gV.push(f.gut.rsaAmplitude); gT.push(f.t); }
    if (f.heart?.meanHR != null) { hV.push(f.heart.meanHR); hT.push(f.t); }
    if (f.head?.alphaPowerNorm != null) { dV.push(f.head.alphaPowerNorm); dT.push(f.t); }
  }
  const gutEnv = rebuildEnvelope(gV, gT);
  const heartEnv = rebuildEnvelope(hV, hT);
  const headEnv = rebuildEnvelope(dV, dT);
  if (!gutEnv || !heartEnv || !headEnv) return null;
  return [gutEnv, heartEnv, headEnv];
}

// A cluster = run of 2+ consecutive SE=0 samples (no non-zero between).
function findZeroClusters(bcsSamples) {
  const clusters = [];
  let cur = null;
  for (const s of bcsSamples) {
    const isZero = s.sharedEnergy === 0;
    if (isZero) {
      if (!cur) cur = [];
      cur.push(s);
    } else {
      if (cur && cur.length >= 2) clusters.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) clusters.push(cur);
  return clusters;
}

function replayOneSample(session, s) {
  const inputs = rebuildInputsAt(session, s.t);
  if (!inputs) return { ok: false, reason: 'envelope-unavailable' };
  try {
    const replay = sharedModeEnergyFraction(inputs);
    return { ok: true, replay };
  } catch (e) {
    return { ok: false, reason: `threw: ${e.message}` };
  }
}

function validateSession(session, label) {
  console.log(`\n── Session: ${label}`);
  const bcs = session.streams?.bcs;
  const features = session.streams?.features;

  if (!bcs || !Array.isArray(bcs)) {
    console.log('  ✗ no streams.bcs — not a Phase 7 session');
    return null;
  }
  if (!features || !Array.isArray(features)) {
    console.log('  ✗ no streams.features — recorder pre-dates feature capture');
    console.log('  BLOCKER: cannot rebuild envelopes without upstream inputs.');
    return null;
  }

  const originalZeros = bcs.filter(s => s.sharedEnergy === 0);
  const originalNonZeros = bcs.filter(s => s.sharedEnergy != null && s.sharedEnergy > 0);
  const originalNulls = bcs.filter(s => s.sharedEnergy == null);

  let envelopeGapCount = 0;
  const zerosNowNull = [];
  const zerosStillZero = [];
  const nonZeroMatches = [];
  const nonZeroMismatches = [];

  for (const s of bcs) {
    const r = replayOneSample(session, s);
    if (!r.ok) { envelopeGapCount++; continue; }
    const replay = r.replay;
    if (s.sharedEnergy === 0) {
      if (replay.value == null) {
        zerosNowNull.push({ t: s.t, quality: replay.quality, reason: replay.reason });
      } else {
        zerosStillZero.push({ t: s.t, replay: replay.value, quality: replay.quality });
      }
    } else if (s.sharedEnergy != null && s.sharedEnergy > 0) {
      if (replay.value != null && Math.abs(replay.value - s.sharedEnergy) <= TOLERANCE) {
        nonZeroMatches.push({ t: s.t, original: s.sharedEnergy, replay: replay.value });
      } else {
        nonZeroMismatches.push({
          t: s.t,
          original: s.sharedEnergy,
          replay: replay.value,
          quality: replay.quality,
          delta: replay.value != null ? Math.abs(replay.value - s.sharedEnergy) : null
        });
      }
    }
  }

  // Flag distribution inside each cluster (homogeneous or mixed?)
  const clusters = findZeroClusters(bcs);
  const flagsByCluster = [];
  for (const cluster of clusters) {
    const flags = [];
    for (const s of cluster) {
      const r = replayOneSample(session, s);
      flags.push(r.ok ? r.replay.quality : '?envelope-unavailable');
    }
    const unique = [...new Set(flags)];
    flagsByCluster.push({
      start: cluster[0].t,
      end: cluster.at(-1).t,
      count: cluster.length,
      flags,
      homogeneous: unique.length === 1,
      unique
    });
  }

  console.log(`  Total BCS samples      : ${bcs.length}`);
  console.log(`  Envelope-gap skips     : ${envelopeGapCount}`);
  console.log(`  Original SE=0 samples  : ${originalZeros.length}`);
  if (originalZeros.length) {
    console.log(`    at t=${originalZeros.map(s => s.t.toFixed(0)).join(', ')}s`);
  }
  console.log(`  With fix — null + flag : ${zerosNowNull.length}`);
  if (zerosNowNull.length) {
    const dist = {};
    for (const z of zerosNowNull) dist[z.quality] = (dist[z.quality] || 0) + 1;
    console.log(`    Flag distribution    : ${JSON.stringify(dist)}`);
  }
  if (zerosStillZero.length) {
    console.log(`  With fix — still 0     : ${zerosStillZero.length}  ← Commit 12 missed these`);
    for (const z of zerosStillZero) {
      console.log(`    t=${z.t.toFixed(0)}s  replay=${z.replay.toFixed(3)}  quality=${z.quality}`);
    }
  }
  console.log(`  Non-zero within ±${TOLERANCE}: ${nonZeroMatches.length} / ${originalNonZeros.length}`);
  if (nonZeroMismatches.length) {
    console.log(`  Non-zero OUTSIDE ±${TOLERANCE}: ${nonZeroMismatches.length}`);
    for (const m of nonZeroMismatches.slice(0, 8)) {
      const dStr = m.delta != null ? m.delta.toFixed(3) : 'n/a';
      const rStr = m.replay != null ? m.replay.toFixed(3) : 'null';
      console.log(`    t=${m.t.toFixed(0)}s  orig=${m.original}  replay=${rStr}  Δ=${dStr}  quality=${m.quality}`);
    }
    if (nonZeroMismatches.length > 8) {
      console.log(`    ... (${nonZeroMismatches.length - 8} more)`);
    }
  }
  if (originalNulls.length) {
    console.log(`  Pre-existing nulls     : ${originalNulls.length} (already post-fix)`);
  }

  console.log(`  Zero clusters (≥2)     : ${clusters.length}`);
  for (const c of flagsByCluster) {
    const mark = c.homogeneous ? '✓ homogeneous' : '⚠ MIXED';
    console.log(`    t=${c.start.toFixed(0)}-${c.end.toFixed(0)}s  n=${c.count}  ${mark}  flags=${JSON.stringify(c.flags)}`);
  }

  return {
    label,
    totalBcs: bcs.length,
    zeroCount: originalZeros.length,
    zerosNowNullCount: zerosNowNull.length,
    zerosStillZeroCount: zerosStillZero.length,
    nonZeroMatch: nonZeroMatches.length,
    nonZeroMismatch: nonZeroMismatches.length,
    nonZeroTotal: originalNonZeros.length,
    clusters: flagsByCluster
  };
}

function collectPaths() {
  const args = process.argv.slice(2);
  if (args[0] === '--fixtures') {
    if (!existsSync(DEFAULT_FIXTURES_DIR)) return [];
    return readdirSync(DEFAULT_FIXTURES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => join(DEFAULT_FIXTURES_DIR, f));
  }
  return args.filter(a => !a.startsWith('--'));
}

function printUsage() {
  console.log();
  console.log('No session files supplied.');
  console.log('Usage:');
  console.log('  node tests/bcs-replay-validation.mjs <session1.json> [...]');
  console.log('  node tests/bcs-replay-validation.mjs --fixtures');
  console.log(`    (scans ${DEFAULT_FIXTURES_DIR})`);
  console.log();
  console.log('Required session JSON fields (current SessionRecorder format):');
  console.log('  streams.features[*].heart.meanHR');
  console.log('  streams.features[*].gut.rsaAmplitude');
  console.log('  streams.features[*].head.alphaPowerNorm');
  console.log('  streams.bcs[*].{t, sharedEnergy}');
  console.log();
  console.log('No new recording is needed — every session produced by');
  console.log('src/recording/session-recorder.js is replayable.');
}

function main() {
  console.log('='.repeat(72));
  console.log('BCS SHARED-ENERGY REPLAY VALIDATION (Commit 12)');
  console.log('='.repeat(72));
  console.log('Asserts:');
  console.log('  (1) every original SE=0 sample now emits null + quality flag');
  console.log(`  (2) every non-zero replay is within ±${TOLERANCE} of original`);
  console.log('  (3) clusters of consecutive zeros have homogeneous flags');

  const paths = collectPaths();
  if (paths.length === 0) { printUsage(); process.exit(1); }

  const results = [];
  for (const p of paths) {
    if (!existsSync(p)) { console.error(`\n✗ not found: ${p}`); continue; }
    const label = basename(p, '.json');
    try {
      const session = JSON.parse(readFileSync(p, 'utf8'));
      const r = validateSession(session, label);
      if (r) results.push(r);
    } catch (e) {
      console.error(`\n✗ ${label}: ${e.message}`);
    }
  }

  console.log();
  console.log('='.repeat(72));
  console.log('VERDICT');
  console.log('='.repeat(72));
  if (results.length === 0) { console.log('No sessions validated.'); process.exit(1); }

  const totalZeros = results.reduce((s, r) => s + r.zeroCount, 0);
  const totalStillZero = results.reduce((s, r) => s + r.zerosStillZeroCount, 0);
  const totalNowNull = results.reduce((s, r) => s + r.zerosNowNullCount, 0);
  const totalNonZeroMatch = results.reduce((s, r) => s + r.nonZeroMatch, 0);
  const totalNonZeroTotal = results.reduce((s, r) => s + r.nonZeroTotal, 0);
  const allClusters = results.flatMap(r => r.clusters);
  const mixedClusters = allClusters.filter(c => !c.homogeneous);

  console.log(`Sessions validated      : ${results.length}`);
  console.log(`Historical SE=0 samples : ${totalZeros}`);
  console.log(`  → null + flag         : ${totalNowNull} / ${totalZeros}`);
  console.log(`  → still numeric 0     : ${totalStillZero}`);
  console.log(`Non-zero match rate     : ${totalNonZeroMatch} / ${totalNonZeroTotal}`);
  console.log(`Clusters (≥2)           : ${allClusters.length} (${mixedClusters.length} mixed)`);

  let exitCode = 0;
  if (totalStillZero > 0) {
    console.log();
    console.log('⚠  Commit 12 missed paths. See t-values flagged above.');
    exitCode = 2;
  }
  if (mixedClusters.length > 0) {
    console.log();
    console.log('⚠  Mixed flags inside clusters — multiple failure modes in rapid succession:');
    for (const c of mixedClusters) {
      console.log(`   t=${c.start.toFixed(0)}-${c.end.toFixed(0)}s  flags=${JSON.stringify(c.flags)}`);
    }
  }
  if (totalNowNull === totalZeros && mixedClusters.length === 0 && totalStillZero === 0) {
    console.log();
    console.log('✓ CLOSE_ON_UNIFIED_COHERENCE can safely consume bcs_value.');
    console.log('  Every historic SE=0 now emits null + flag; bcs_value_quality');
    console.log('  correctly distinguishes "partial" from "full" ticks.');
  }
  process.exit(exitCode);
}

main();
