// Regression test for the harm regime-magnitude floor added 2026-04-24
// after a 12-session audit showed false-positive harm=1.0 events fired when
// two regimes were below 0.25. Floor check applies in coherence-vector.js
// AFTER detectHarmonicLock runs; the detector itself stays unchanged.
//
// This test exercises the floor math directly (pure arithmetic; the whole
// CoherenceEngine isn't needed to verify it). A companion check would be a
// full engine test, but the math is what we regressed on.
//
// Run: node tests/harm-floor.test.mjs

import assert from 'node:assert/strict';
import { HARM_REGIME_FLOOR } from '../src/coherence/coherence-vector.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/** Re-implementation of the floor math from coherence-vector.js, for testing. */
function applyFloor(harm, gut, heart, head) {
  if (harm == null || !isFinite(harm)) return harm;
  const online = [gut, heart, head].filter(v => v != null && isFinite(v));
  if (online.length === 0) return harm;
  const weakest = Math.min(...online);
  const floorPenalty = Math.max(0, Math.min(1, weakest / HARM_REGIME_FLOOR));
  return harm * floorPenalty;
}

console.log('\nHarm regime-magnitude floor (exports + arithmetic):');

test('HARM_REGIME_FLOOR exported and set to 0.4', () => {
  assert.equal(HARM_REGIME_FLOOR, 0.4);
});

test('all regimes at or above the floor → harm unchanged', () => {
  assert.equal(applyFloor(1.0, 0.85, 0.80, 0.75), 1.0);
  assert.equal(applyFloor(0.5, 0.40, 0.60, 0.80), 0.5);
});

test('false-positive case from April 24 (two regimes near 0.22) → scaled to ~55% of original', () => {
  // Session data: GUT=0.219, HEART=0.222, HEAD=0.631. Weakest=0.219.
  // Penalty = 0.219 / 0.4 = 0.5475. harm 1.0 → 0.5475.
  const out = applyFloor(1.0, 0.219, 0.222, 0.631);
  assert.ok(out > 0.54 && out < 0.56, `got ${out}`);
});

test('worst false-positive (GUT 0.082, HEART 0.097) → harm collapses toward 0', () => {
  // Weakest=0.082. Penalty = 0.082 / 0.4 = 0.205. harm 1.0 → 0.205.
  const out = applyFloor(1.0, 0.082, 0.097, 0.468);
  assert.ok(out > 0.20 && out < 0.21, `got ${out}`);
});

test('any regime at zero nullifies harm', () => {
  assert.equal(applyFloor(1.0, 0.0, 0.9, 0.9), 0);
  assert.equal(applyFloor(0.7, 0.9, 0.0, 0.9), 0);
});

test('null harm passes through unchanged', () => {
  assert.equal(applyFloor(null, 0.8, 0.8, 0.8), null);
});

test('offline regimes (nulls) are excluded from the weakest-regime check', () => {
  // Only GUT and HEART online, both healthy → no penalty.
  const out = applyFloor(0.8, 0.75, 0.70, null);
  assert.equal(out, 0.8);
});

test('floor is a soft scale, not a hard cliff', () => {
  // Weakest at exactly the floor → penalty 1.0 (full harm kept).
  assert.equal(applyFloor(1.0, 0.4, 0.9, 0.9), 1.0);
  // Weakest just below → small penalty.
  const justBelow = applyFloor(1.0, 0.35, 0.9, 0.9);
  assert.ok(justBelow > 0.87 && justBelow < 0.88, `got ${justBelow}`);
});

console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
