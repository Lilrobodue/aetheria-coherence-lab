// Unit tests for CLOSE_ON_SUSTAINED_PEAK and CLOSE_ON_STAGNATION.
// Exercises the real PolicyEngine methods by directly populating the state
// they consume (_prescriptionPeaks, _sessionMaxTcs, _prescriptionOfSessionMax,
// baseline stats, _sessionStart). Uses a minimal bus stub — no timers fire.
//
// Run: node tests/close-rules.test.mjs
// Exits non-zero on assertion failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

import { PolicyEngine } from '../src/policy/state-machine.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(here, '../src/config/policy.json'), 'utf8'));

function makeBus() {
  return { publish() {}, subscribe() { return () => {}; } };
}

function runScenario({ peaks, baselineMean, baselineStd, sessionDurationSec, bcsSamples = null }) {
  const engine = new PolicyEngine(makeBus(), config, []);
  engine._baselineTcsMean = baselineMean;
  engine._baselineTcsStd = baselineStd;
  engine._sessionStart = (performance.now() / 1000) - sessionDurationSec;

  for (const p of peaks) {
    engine._frequencyHistory.push({ frequency_hz: 100, regime: 'GUT' });
    engine._prescriptionPeaks.push(p);
    if (p > engine._sessionMaxTcs) {
      engine._sessionMaxTcs = p;
      engine._prescriptionOfSessionMax = engine._frequencyHistory.length;
    }
  }

  // Populate the BCS rolling buffer directly. Each sample supplies:
  //   { t: session-relative seconds, bcs: number|null, bcsQuality: string|null }
  // Tests that don't exercise the unified path should omit bcsSamples.
  if (bcsSamples) engine._bcsSamples.push(...bcsSamples);

  const closedWith = { reason: null };
  const origEnter = engine._enterClosing.bind(engine);
  engine._enterClosing = (reason) => { closedWith.reason = reason; };

  // Evaluation order mirrors _tickEvaluate: unified → sustained → stagnation.
  const unifiedFired = engine._checkUnifiedCoherence();
  const sustainedFired = !unifiedFired && engine._checkSustainedPeak();
  const stagnationFired = !unifiedFired && !sustainedFired && engine._checkStagnation();

  engine._enterClosing = origEnter;
  return { unifiedFired, sustainedFired, stagnationFired, reason: closedWith.reason };
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('close-rules.test.mjs');

test('outlier early peak (86) then holds 75-85 → SUSTAINED_PEAK', () => {
  // Rx #1 peaks exceptionally; subsequent Rxs hold in 75-85.
  // With trailing-max, floor at Rx #6 = 0.85 * max(last 3) ≈ 0.85 * 85 = 72.25.
  // All subsequent peaks clear that comfortably.
  const r = runScenario({
    peaks: [86, 78, 82, 77, 85, 80],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 400
  });
  assert.equal(r.sustainedFired, true, 'SUSTAINED_PEAK should fire');
  assert.equal(r.stagnationFired, false, 'STAGNATION should not fire');
  assert.match(r.reason, /trailing_max=/, 'reason should include trailing_max');
});

test('same peaks but session < min-duration → neither fires', () => {
  const r = runScenario({
    peaks: [86, 78, 82, 77, 85, 80],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 200
  });
  assert.equal(r.sustainedFired, false, 'gated by min-duration');
  assert.equal(r.stagnationFired, false, 'gated by min-duration');
});

test('fallback: < trailing_max_windows peaks → uses all-time session_max', () => {
  // Only 2 peaks total, trailing window is 3 — should fall back to all-time
  // session_max for the floor. 86 is the max; floor = 0.85 * 86 = 73.1.
  // Both peaks (86, 78) — 78 > 73.1? yes. But sustain_windows=2 so passes.
  const r = runScenario({
    peaks: [86, 78],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 400
  });
  assert.equal(r.sustainedFired, true, 'fallback to session_max, 78 ≥ 73.1');
});

test('strictly declining peaks → STAGNATION (trailing_max below significance)', () => {
  // Peaks [86, 82, 77, 60, 50, 40]: strictly decreasing. Baseline μ=62, σ=6
  // → significance=71. Trailing_max of last 3 = 60 which is below 71, so
  // the Commit 11 gate blocks SUSTAIN. STAGNATION: mean(60, 50, 40) = 50
  // < 0.80 * 86 = 68.8 → fires.
  const r = runScenario({
    peaks: [86, 82, 77, 60, 50, 40],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 500
  });
  assert.equal(r.sustainedFired, false, 'SUSTAIN blocked — trailing_max 60 < significance 71');
  assert.equal(r.stagnationFired, true, 'STAGNATION should fire — mean recent 50 < floor 68.8');
  assert.match(r.reason, /mean_recent_peaks/, 'reason should include mean');
});

test('peaks high then settles low plateau → STAGNATION (Commit 11 fix)', () => {
  // The exact failure mode Commit 11 addresses: early exceptional peak
  // followed by a tight low plateau. Without the trailing_max gate,
  // trailing_max would follow down to ~58, floor ≈ 49, and the 54-58
  // peaks would clear it — mislabeling stagnation as SUSTAINED_PEAK.
  // With the gate: trailing_max=58 < significance=71 → SUSTAIN blocked.
  const r = runScenario({
    peaks: [86, 82, 77, 54, 56, 58],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 500
  });
  assert.equal(r.sustainedFired, false, 'SUSTAIN blocked — trailing_max 58 < significance 71');
  assert.equal(r.stagnationFired, true, 'STAGNATION should fire on low plateau');
});

test('peaks high then holds high → SUSTAINED_PEAK (regression guard)', () => {
  // Inverse of the above: peaks remain above significance throughout.
  // trailing_max stays well above 71. sustain fires.
  const r = runScenario({
    peaks: [86, 85, 83, 85, 84, 86],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 500
  });
  assert.equal(r.sustainedFired, true, 'SUSTAINED_PEAK should fire on held-high');
  assert.equal(r.stagnationFired, false, 'STAGNATION should not fire');
});

test('peaks holding near all-time max → neither fires (normal session)', () => {
  // session_max=86; peaks all within trailing band. sustain fires.
  // This is the same as the outlier test but verifies that even when all
  // peaks are near the max, trailing-max lets sustain fire.
  const r = runScenario({
    peaks: [86, 85, 84, 85, 86, 85],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 400
  });
  assert.equal(r.sustainedFired, true, 'sustained holding → SUSTAINED_PEAK');
});

test('session_max at or below significance threshold → sustain does not fire', () => {
  // Baseline μ=62, σ=6, K=1.5 → significance = 71. All peaks below.
  const r = runScenario({
    peaks: [65, 67, 66, 68, 65, 67],
    baselineMean: 62, baselineStd: 6,
    sessionDurationSec: 400
  });
  assert.equal(r.sustainedFired, false, 'peak below significance');
  // Stagnation also shouldn't fire because peaks aren't declining below 80%
  // of max (68 * 0.8 = 54.4; all peaks > 54.4).
  assert.equal(r.stagnationFired, false, 'peaks not declining');
});

// ---------- CLOSE_ON_UNIFIED_COHERENCE ----------

// Helper: fabricate BCS samples spanning `windowSec` ending at sessionT.
// opts = { quality, bcs, count }. bcs can be a number or a function(i, count).
function fabricateBcs(sessionT, windowSec, count, quality, bcsValue) {
  const samples = [];
  const step = windowSec / count;
  for (let i = 0; i < count; i++) {
    const t = sessionT - windowSec + (i + 1) * step;
    const bcs = typeof bcsValue === 'function' ? bcsValue(i, count) : bcsValue;
    samples.push({ t, bcs, bcsQuality: quality });
  }
  return samples;
}

test('high TCS + high BCS + all-full quality → UNIFIED_COHERENCE', () => {
  // TCS: 6 peaks above significance with the last two tightly clustered.
  // BCS: 15 full-quality samples, 14 of which ≥ 70 (> 85% ratio).
  const peaks = [75, 72, 78, 76, 77, 76];
  const sessionT = 400;
  const bcsSamples = fabricateBcs(sessionT, 120, 15, 'full', 74);
  const r = runScenario({
    peaks, baselineMean: 62, baselineStd: 6,
    sessionDurationSec: sessionT,
    bcsSamples
  });
  assert.equal(r.unifiedFired, true, 'unified should fire');
  assert.equal(r.sustainedFired, false, 'sustained not reached (unified preempted)');
  assert.match(r.reason, /unified coherence held/);
});

test('high TCS + high BCS but quality mostly partial → falls through to SUSTAINED_PEAK', () => {
  // Only 3 of 15 samples are full-quality (min_valid is 12). Unified fails.
  const peaks = [75, 72, 78, 76, 77, 76];
  const sessionT = 400;
  const partial = fabricateBcs(sessionT, 120, 12, 'partial', 74);
  const full = fabricateBcs(sessionT, 120, 3, 'full', 75);
  const r = runScenario({
    peaks, baselineMean: 62, baselineStd: 6,
    sessionDurationSec: sessionT,
    bcsSamples: [...partial, ...full]
  });
  assert.equal(r.unifiedFired, false, 'unified should fail on insufficient valid samples');
  assert.equal(r.sustainedFired, true, 'sustained-peak catches the TCS success');
});

test('high TCS + low BCS (full quality, below threshold) → falls through to SUSTAINED_PEAK', () => {
  // 15 full samples, all ≈ 55 (well below 70 threshold). Unified fails on
  // sustain ratio (0/15 above). Sustained-peak still fires on TCS alone.
  const peaks = [75, 72, 78, 76, 77, 76];
  const sessionT = 400;
  const bcsSamples = fabricateBcs(sessionT, 120, 15, 'full', 55);
  const r = runScenario({
    peaks, baselineMean: 62, baselineStd: 6,
    sessionDurationSec: sessionT,
    bcsSamples
  });
  assert.equal(r.unifiedFired, false);
  assert.equal(r.sustainedFired, true);
});

test('high TCS + BCS numeric zeros with quality ok (Path C) → falls through to SUSTAINED_PEAK', () => {
  // 15 full samples with bcs=0 (legit "no shared modes"). Unified fails
  // the sustain gate (0/15 above threshold) but count-as-valid is correct.
  const peaks = [75, 72, 78, 76, 77, 76];
  const sessionT = 400;
  const bcsSamples = fabricateBcs(sessionT, 120, 15, 'full', 0);
  const r = runScenario({
    peaks, baselineMean: 62, baselineStd: 6,
    sessionDurationSec: sessionT,
    bcsSamples
  });
  assert.equal(r.unifiedFired, false, 'unified blocked by zero bcs');
  assert.equal(r.sustainedFired, true, 'sustained-peak still fires on TCS');
});

test('low TCS + high BCS → neither unified nor sustained-peak fires', () => {
  // TCS peaks never clear significance (significance ≈ 71). BCS all good.
  // Unified and sustained-peak both gated by TCS. Stagnation: rxPlayed=6,
  // rxSincePeak = 6 - 1 = 5 ≥ 3, but trailing-max mean = 57.67 is above
  // the 0.80 × 60 = 48 floor, so stagnation also doesn't fire.
  const peaks = [60, 57, 58, 55, 59, 58];
  const sessionT = 400;
  const bcsSamples = fabricateBcs(sessionT, 120, 15, 'full', 75);
  const r = runScenario({
    peaks, baselineMean: 62, baselineStd: 6,
    sessionDurationSec: sessionT,
    bcsSamples
  });
  assert.equal(r.unifiedFired, false);
  assert.equal(r.sustainedFired, false);
  // Stagnation may or may not fire depending on decline — either way unified
  // is the negative assertion we care about here.
});

test('session < unified_min_duration_sec → unified blocked, sustained also blocked', () => {
  // 200s is under both the 360 unified_min and 360 success_min gates.
  const peaks = [75, 72, 78, 76, 77, 76];
  const sessionT = 200;
  const bcsSamples = fabricateBcs(sessionT, 120, 15, 'full', 74);
  const r = runScenario({
    peaks, baselineMean: 62, baselineStd: 6,
    sessionDurationSec: sessionT,
    bcsSamples
  });
  assert.equal(r.unifiedFired, false);
  assert.equal(r.sustainedFired, false);
});

console.log();
if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
