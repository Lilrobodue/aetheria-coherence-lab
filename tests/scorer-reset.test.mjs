// Regression test for the stale-calibration bug found in session
// Joe-new-aetheria-session-2 (2026-04-24): the RegimeScorer persisted its
// calibration across sessions because the CoherenceEngine is a shared
// singleton. When session N's high-HRV baseline calibrated the z-scorers,
// session N+1's first 91s of data was z-scored against those stale means,
// pegging z-scores at the clamp floor (−4) and producing sigmoid≈0.045 with
// sd≈0.003 for GUT coherence.
//
// Run: node tests/scorer-reset.test.mjs

import assert from 'node:assert/strict';
import { ZScorer, sigmoid } from '../src/math/stats.js';
import { RegimeScorer } from '../src/coherence/regime-scoring.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nZScorer.reset:');

test('reset() clears calibration flag and rescores as zero', () => {
  const z = new ZScorer();
  z.calibrate([10, 12, 14, 16, 18]);
  assert.equal(z.calibrated, true);
  assert.ok(Math.abs(z.score(14)) < 0.1); // near mean → ~0
  z.reset();
  assert.equal(z.calibrated, false);
  assert.equal(z.score(14), 0); // uncalibrated always returns 0
});

console.log('\nRegimeScorer.reset:');

test('reset() lets a fresh session calibrate cleanly after a prior session', () => {
  const sc = new RegimeScorer();
  // Session 1: high-HRV resting state — calibrates mean high
  sc.calibrate({
    hfPower:      [500, 520, 510, 505, 515, 500, 500, 510],
    sd1:          [30, 31, 29, 30, 32, 30, 31, 30],
    rsaAmplitude: [60, 62, 61, 60, 63, 60, 62, 60],
    hrvCoherence: [3, 3.2, 3.1, 3, 3.2, 3, 3.1, 3],
    rmssd:        [45, 46, 44, 45, 46, 44, 45, 46],
    hfNorm:       [0.55, 0.56, 0.55, 0.54, 0.55, 0.56, 0.55, 0.54],
    alphaPowerNorm: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
    thetaAlphaRatio: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    hbDiff:       [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
    betaPower:    [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
  });
  assert.equal(sc.calibrated, true);

  // Session 2: moderate features — without reset, scores pinned near 0
  const session2Gut = { hfPower: 195, sd1: 24, rsaAmplitude: 45 };
  const stale = sc.scoreGut(session2Gut);
  assert.ok(stale.sigmoid < 0.1,
    `expected stale score to be pinned low, got ${stale.sigmoid}`);

  // After reset the scorer falls back to the pre-baseline heuristic path.
  sc.reset();
  assert.equal(sc.calibrated, false);
  const fresh = sc.scoreGut(session2Gut);
  assert.ok(fresh.sigmoid > 0.5,
    `fresh (uncalibrated) score should land in healthy range for healthy HRV; got ${fresh.sigmoid}`);
});

test('reset() + new calibrate() produces sensible z-scores on session-2 distribution', () => {
  const sc = new RegimeScorer();
  // Session 1 calibration (high)
  sc.calibrate({
    hfPower:      [500, 520, 510, 505, 515, 500, 500, 510],
    sd1:          [30, 31, 29, 30, 32, 30, 31, 30],
    rsaAmplitude: [60, 62, 61, 60, 63, 60, 62, 60],
    hrvCoherence: [3, 3.2, 3.1, 3, 3.2, 3, 3.1, 3],
    rmssd:        [45, 46, 44, 45, 46, 44, 45, 46],
    hfNorm:       [0.55, 0.56, 0.55, 0.54, 0.55, 0.56, 0.55, 0.54],
    alphaPowerNorm: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
    thetaAlphaRatio: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    hbDiff:       [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
    betaPower:    [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
  });
  sc.reset();
  // Session 2 calibration on its own moderate distribution
  sc.calibrate({
    hfPower:      [195, 190, 200, 205, 198, 192, 200, 195],
    sd1:          [24, 23.5, 24.2, 24, 23.8, 24, 24.3, 24],
    rsaAmplitude: [45, 44, 46, 45, 44, 45, 46, 45],
    hrvCoherence: [2.5, 2.4, 2.6, 2.5, 2.4, 2.5, 2.6, 2.5],
    rmssd:        [34, 33, 34, 34, 33, 34, 34, 33],
    hfNorm:       [0.13, 0.12, 0.13, 0.13, 0.12, 0.13, 0.13, 0.12],
    alphaPowerNorm: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
    thetaAlphaRatio: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
    hbDiff:       [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
    betaPower:    [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
  });
  // A value near the NEW mean should score near 0.5 (its own distribution).
  const mid = sc.scoreGut({ hfPower: 196, sd1: 24, rsaAmplitude: 45 });
  assert.ok(mid.sigmoid > 0.35 && mid.sigmoid < 0.65,
    `midpoint of session-2 distribution should score ~0.5, got ${mid.sigmoid}`);
});

console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
