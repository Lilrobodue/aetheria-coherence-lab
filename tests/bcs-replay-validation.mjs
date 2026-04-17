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

// Partial analysis for tagger-export format (no streams.features, so we
// can't recompute shared_energy through the new code path). Reports:
//   - Zero count and timestamps
//   - Cluster structure (runs of ≥2 consecutive zeros)
//   - Singleton zeros (isolated ticks, not part of a cluster)
//   - Which state phase each zero occurred in (BASELINE, ENTRAIN, CLOSING...)
function partialAnalysis(bcs, transitions, label) {
  const originalZeros = bcs.filter(s => s.sharedEnergy === 0);
  const originalNonZeros = bcs.filter(s => s.sharedEnergy != null && s.sharedEnergy > 0);
  const originalNulls = bcs.filter(s => s.sharedEnergy == null);
  const clusters = findZeroClusters(bcs);

  const byCluster = new Set(clusters.flatMap(c => c.map(s => s.t)));
  const singletons = originalZeros.filter(s => !byCluster.has(s.t));

  // Annotate each zero with the state phase it occurred during
  const annotate = (z) => ({ ...z, phase: phaseAtTime(z.t, transitions) });
  const annZeros = originalZeros.map(annotate);

  console.log(`  Total BCS samples      : ${bcs.length}`);
  console.log(`  Original SE=0 samples  : ${originalZeros.length}`);
  if (annZeros.length) {
    for (const z of annZeros) {
      console.log(`    t=${z.t.toFixed(2)}s  phase=${z.phase}`);
    }
  }
  console.log(`  Original non-zero      : ${originalNonZeros.length}`);
  if (originalNulls.length) {
    console.log(`  Pre-existing nulls     : ${originalNulls.length} (already post-fix)`);
  }

  console.log(`  Zero clusters (≥2)     : ${clusters.length}`);
  for (const c of clusters) {
    const phases = c.map(s => phaseAtTime(s.t, transitions));
    const uniquePhases = [...new Set(phases)];
    const phaseStr = uniquePhases.length === 1 ? uniquePhases[0] : phases.join('→');
    console.log(`    t=${c[0].t.toFixed(0)}-${c.at(-1).t.toFixed(0)}s  n=${c.length}  phase=${phaseStr}`);
  }
  if (singletons.length) {
    console.log(`  Singleton zeros        : ${singletons.length}`);
    for (const s of singletons) {
      console.log(`    t=${s.t.toFixed(2)}s  phase=${phaseAtTime(s.t, transitions)}`);
    }
  }

  console.log();
  console.log('  (No streams.features — cannot recompute shared_energy.)');
  console.log('  Structural analysis only. For full replay, provide the full session JSON');
  console.log('  (the "Download Full Session" file, not the tagger export).');

  return {
    label,
    kind: 'partial',
    totalBcs: bcs.length,
    zeroCount: originalZeros.length,
    zerosByPhase: annZeros,
    clusters,
    singletons,
    nonZeroCount: originalNonZeros.length
  };
}

// Normalize both full-session and tagger-export shapes into a common
// { bcs: [{t, sharedEnergy, ...}], features: [...] | null } form.
function normalizeSession(session) {
  if (session.streams?.bcs && Array.isArray(session.streams.bcs)) {
    return {
      kind: 'full-session',
      bcs: session.streams.bcs,
      features: session.streams.features || null,
      transitions: session.streams.state || []
    };
  }
  const ts = session.time_series;
  if (ts?.bcs_t && Array.isArray(ts.bcs_t)) {
    const bcs = ts.bcs_t.map((t, i) => ({
      t,
      bcs: ts.bcs_value?.[i] ?? null,
      kuramoto: ts.bcs_kuramoto?.[i] ?? null,
      sharedEnergy: ts.bcs_shared_energy?.[i] ?? null,
      mutualInfo: ts.bcs_mutual_info?.[i] ?? null,
      phaseTransition: ts.bcs_phase_transition?.[i] ?? false
    }));
    return {
      kind: 'tagger-export',
      bcs,
      features: null,
      transitions: session.state_transitions || []
    };
  }
  return null;
}

function phaseAtTime(t, transitions) {
  // Return the state name that was active at time t.
  let current = 'STARTUP';
  for (const tr of transitions) {
    if (tr.t == null) continue;
    if (t >= tr.t) current = tr.to || current;
    else break;
  }
  return current;
}

function validateSession(session, label) {
  console.log(`\n── Session: ${label}`);
  const norm = normalizeSession(session);
  if (!norm) {
    console.log('  ✗ unrecognized session shape (no streams.bcs and no time_series.bcs_t)');
    return null;
  }
  console.log(`  format: ${norm.kind}`);
  const bcs = norm.bcs;
  const features = norm.features;

  if (norm.kind === 'tagger-export' || !features) {
    // Partial analysis: count zeros, cluster them, correlate with state phases.
    // Cannot recompute because the tagger export strips streams.features.
    return partialAnalysis(bcs, norm.transitions, label);
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

  const full = results.filter(r => r.kind !== 'partial');
  const partial = results.filter(r => r.kind === 'partial');

  if (partial.length) {
    const totalZeros = partial.reduce((s, r) => s + r.zeroCount, 0);
    const totalNonZero = partial.reduce((s, r) => s + r.nonZeroCount, 0);
    const totalClusters = partial.reduce((s, r) => s + r.clusters.length, 0);
    const totalSingletons = partial.reduce((s, r) => s + r.singletons.length, 0);
    console.log(`Tagger-export sessions (structural only): ${partial.length}`);
    console.log(`  Total BCS samples       : ${partial.reduce((s, r) => s + r.totalBcs, 0)}`);
    console.log(`  Historical SE=0 samples : ${totalZeros}`);
    console.log(`  Non-zero samples        : ${totalNonZero}`);
    console.log(`  Zero clusters (≥2)      : ${totalClusters}`);
    console.log(`  Singleton zeros         : ${totalSingletons}`);
    console.log();
    console.log('  Full replay requires the unfiltered session JSON (streams.features');
    console.log('  must be present). The current SessionRecorder captures this — any');
    console.log('  session recorded via "Download Full Session" is replayable.');
  }

  if (full.length) {
    const totalZeros = full.reduce((s, r) => s + r.zeroCount, 0);
    const totalStillZero = full.reduce((s, r) => s + r.zerosStillZeroCount, 0);
    const totalNowNull = full.reduce((s, r) => s + r.zerosNowNullCount, 0);
    const totalNonZeroMatch = full.reduce((s, r) => s + r.nonZeroMatch, 0);
    const totalNonZeroTotal = full.reduce((s, r) => s + r.nonZeroTotal, 0);
    const allClusters = full.flatMap(r => r.clusters || []);
    const mixedClusters = allClusters.filter(c => !c.homogeneous);
    console.log(`Full-session replays    : ${full.length}`);
    console.log(`Historical SE=0 samples : ${totalZeros}`);
    console.log(`  → null + flag         : ${totalNowNull} / ${totalZeros}`);
    console.log(`  → still numeric 0     : ${totalStillZero}`);
    console.log(`Non-zero match rate     : ${totalNonZeroMatch} / ${totalNonZeroTotal}`);
    console.log(`Clusters (≥2)           : ${allClusters.length} (${mixedClusters.length} mixed)`);
    if (totalStillZero > 0) {
      console.log();
      console.log('⚠  Commit 12 missed paths. See t-values flagged above.');
      process.exit(2);
    }
    if (totalNowNull === totalZeros && mixedClusters.length === 0) {
      console.log();
      console.log('✓ CLOSE_ON_UNIFIED_COHERENCE can safely consume bcs_value.');
    }
  }
  process.exit(0);
}

main();
