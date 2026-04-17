// Unit tests for the BCS shared-energy quality fix (Commit 12).
// Covers:
//   - Flat/near-zero input that historically produced 0.0 now returns
//     { value: null, quality: 'low_variance' }
//   - Normal synchronized sinusoidal input still composes the same
//     numeric BCS as before (regression guard)
//   - composeBcs with null SE rescales K+MI weights and flags 'partial'
//
// Run: node tests/bcs-quality.test.mjs
// Exits non-zero on assertion failure.

import assert from 'node:assert/strict';
import { sharedModeEnergyFraction } from '../src/bcs/memd.js';
import { composeBcs } from '../src/bcs/bcs-engine.js';

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

console.log('bcs-quality.test.mjs');

// ---------- Path A: flat input → low_variance ----------
test('flat channels → { value: null, quality: "low_variance" }', () => {
  const n = 64;
  const flat = new Float64Array(n); // all zeros
  const result = sharedModeEnergyFraction([flat, flat, flat]);
  assert.equal(result.value, null, 'value should be null');
  assert.equal(result.quality, 'low_variance', 'quality flag should be low_variance');
  assert.match(result.reason, /no_imfs/, 'reason should reference no_imfs');
});

test('near-zero amplitude input → null + low_variance', () => {
  const n = 64;
  // Amplitude 1e-20: energy per-sample is 1e-40, total energy across 3x64
  // is ~2e-38, below the 1e-10 * len * nCh = 1.92e-8 threshold.
  const epsilon = 1e-20;
  const a = new Float64Array(n).map((_, i) => epsilon * Math.sin(i));
  const b = new Float64Array(n).map((_, i) => epsilon * Math.sin(i * 1.1));
  const c = new Float64Array(n).map((_, i) => epsilon * Math.sin(i * 0.9));
  const result = sharedModeEnergyFraction([a, b, c]);
  assert.equal(result.value, null);
  assert.equal(result.quality, 'low_variance');
});

// ---------- Normal input → ok + numeric value ----------
test('synchronized sinusoids → numeric value, quality "ok"', () => {
  const n = 128;
  const gut = new Float64Array(n);
  const heart = new Float64Array(n);
  const head = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 10;
    gut[i] = Math.sin(t) + 0.3 * Math.sin(t * 3.1);
    heart[i] = 0.9 * Math.sin(t + 0.2) + 0.2 * Math.sin(t * 3.1);
    head[i] = 0.85 * Math.sin(t - 0.1) + 0.25 * Math.sin(t * 3.1);
  }
  const result = sharedModeEnergyFraction([gut, heart, head]);
  assert.equal(typeof result.value, 'number', 'value should be a number');
  assert.equal(result.quality, 'ok', 'quality should be ok');
  assert.ok(result.value >= 0 && result.value <= 1, `value should be in [0,1], got ${result.value}`);
});

// ---------- composeBcs: all valid → full ----------
test('composeBcs with all three valid → quality "full"', () => {
  const w = { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
  const r = composeBcs({ kuramoto: 0.8, sharedEnergy: 0.6, mutualInfo: 0.5 }, w);
  // Expected: 100 * (0.40*0.8 + 0.35*0.6 + 0.25*0.5) = 100 * (0.32 + 0.21 + 0.125) = 65.5
  assert.equal(r.quality, 'full');
  assert.ok(Math.abs(r.bcs - 65.5) < 0.001, `expected 65.5, got ${r.bcs}`);
});

// ---------- composeBcs: null SE → partial with rescaled weights ----------
test('composeBcs with null sharedEnergy → partial, rescaled to original scale', () => {
  const w = { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
  const r = composeBcs({ kuramoto: 0.8, sharedEnergy: null, mutualInfo: 0.5 }, w);
  // With SE absent, rescale K+MI weights: scale = (0.40+0.35+0.25) / (0.40+0.25) = 1.0/0.65
  // bcs = 100 * (1.0/0.65) * (0.40*0.8 + 0.25*0.5) = 100 * 1.5385 * (0.32 + 0.125) = 100 * 1.5385 * 0.445 = 68.46
  assert.equal(r.quality, 'partial');
  const expected = 100 * (1 / 0.65) * (0.40 * 0.8 + 0.25 * 0.5);
  assert.ok(Math.abs(r.bcs - expected) < 0.001, `expected ${expected.toFixed(2)}, got ${r.bcs}`);
});

// ---------- composeBcs: regression guard — verify math for normal case ----------
test('composeBcs with same weights as policy default reproduces old arithmetic', () => {
  const w = { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
  const r = composeBcs({ kuramoto: 0.75, sharedEnergy: 0.55, mutualInfo: 0.45 }, w);
  // Legacy formula: 100 * (0.40*K + 0.35*SE + 0.25*MI)
  const expected = 100 * (0.40 * 0.75 + 0.35 * 0.55 + 0.25 * 0.45);
  assert.equal(r.quality, 'full');
  assert.ok(Math.abs(r.bcs - expected) < 0.001, `expected ${expected}, got ${r.bcs}`);
});

// ---------- composeBcs: null K or MI → unavailable ----------
test('composeBcs with null kuramoto → quality "unavailable"', () => {
  const w = { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
  const r = composeBcs({ kuramoto: NaN, sharedEnergy: 0.5, mutualInfo: 0.4 }, w);
  assert.equal(r.quality, 'unavailable');
  assert.equal(r.bcs, null);
});

test('composeBcs with null mutualInfo → quality "unavailable"', () => {
  const w = { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
  const r = composeBcs({ kuramoto: 0.7, sharedEnergy: 0.5, mutualInfo: NaN }, w);
  assert.equal(r.quality, 'unavailable');
  assert.equal(r.bcs, null);
});

console.log();
if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
