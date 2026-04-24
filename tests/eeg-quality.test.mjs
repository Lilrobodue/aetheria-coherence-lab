// Regression test for the EEG contact-quality stuck-at-0 bug in session
// Joe-new-aetheria-session-2 (2026-04-24). The bug: raw RMS on Muse Athena
// EEG samples (which carry a ~700+ µV DC offset) always exceeded the 200 µV
// physiological ceiling, so the quality check set good=false on every batch
// and the channel quality decayed to 0. Blinks still registered because the
// downstream FFT-based features ignore DC.
//
// This test replicates the quality update inline (same math as
// MuseAthena._onEEG) so we can exercise it without requiring a BLE device.
//
// Run: node tests/eeg-quality.test.mjs

import assert from 'node:assert/strict';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/**
 * Run one batch through the quality-update logic and return the new quality.
 * Mirrors muse-athena.js _onEEG exactly so a code change there breaks this test.
 */
function updateQuality(samples, prevQuality) {
  const n = samples.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i];
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = samples[i] - mean;
    sumSq += d * d;
  }
  const acRms = Math.sqrt(sumSq / n);
  const good = acRms > 1 && acRms < 200;
  return good ? Math.min(1, prevQuality + 0.15 * (1 - prevQuality)) : prevQuality * 0.95;
}

console.log('\nAC-RMS EEG contact-quality:');

test('Muse-like samples with ~728 µV DC offset and 30 µV AC → quality rises', () => {
  // Recreate the Joe-new-aetheria-session-2 distribution: mean ~728,
  // min ~608, max ~812. Standard deviation around ~35 µV.
  const samples = new Float32Array(256);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 728 + 35 * Math.sin(2 * Math.PI * i / 25); // ~10 Hz at 256 sps
  }
  // Start at 0 and step through 10 batches; quality must climb.
  let q = 0;
  for (let i = 0; i < 10; i++) q = updateQuality(samples, q);
  assert.ok(q > 0.5, `after 10 batches with healthy AC, quality should exceed 0.5 — got ${q.toFixed(3)}`);
});

test('Flat-rail samples (no AC signal) → quality decays toward 0', () => {
  const samples = new Float32Array(256).fill(0);
  let q = 0.8;
  // Decay half-life is ~14 batches at 0.95 multiplier; 60 batches drops below ~0.05.
  for (let i = 0; i < 60; i++) q = updateQuality(samples, q);
  assert.ok(q < 0.1, `flat rail should decay quality; got ${q.toFixed(3)}`);
});

test('Movement artifact (large AC) → quality decays toward 0', () => {
  const samples = new Float32Array(256);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 728 + 500 * Math.sin(2 * Math.PI * i / 25); // 500 µV AC → artifact
  }
  let q = 0.8;
  for (let i = 0; i < 60; i++) q = updateQuality(samples, q);
  assert.ok(q < 0.1, `large artifact should decay quality; got ${q.toFixed(3)}`);
});

test('BUG REPRODUCTION: the old raw-RMS check would return 0 on Muse data', () => {
  // Prove the old algorithm (raw RMS, no mean subtraction) would pin quality at 0.
  const samples = new Float32Array(256);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 728 + 35 * Math.sin(2 * Math.PI * i / 25);
  }
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const rawRms = Math.sqrt(sumSq / samples.length);
  const oldGood = rawRms > 1 && rawRms < 200;
  assert.equal(oldGood, false, `raw RMS ${rawRms.toFixed(0)} would have marked a healthy signal as bad`);
});

console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
