// Regression + tuning tests for the cross-regime escalation gate.
//
// Gate evolved in three steps:
//   v1 (shipped) — compared TCS peaks vs TCS baseline × ratio; scale mismatch
//                  meant escalation never fired. BUG.
//   v2          — fixed scale: regime coherence peak vs regime baseline × 0.55.
//                  Spec-correct but proved too lenient: session-4 HEART peaks
//                  of 0.83 trivially cleared the 0.245 threshold despite the
//                  session running 15 min in HEART without sustain.
//   v3 (current) — sustain-based: escalate when the rolling mean of per-
//                  prescription regime-coherence means fails to climb above
//                  baseline + regime_exhaustion_mean_delta (default 0.10).
//
// Run: node tests/regime-escalation.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PolicyEngine } from '../src/policy/state-machine.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(here, '../src/config/policy.json'), 'utf8'));

function makeBus() { return { publish() {}, subscribe() { return () => {}; } }; }

function mkEngine({ targetRegime, baselineRegimeMean, attempts, coherenceMeans, coherencePeaks = [], tcsPeaks = [] }) {
  const engine = new PolicyEngine(makeBus(), config, []);
  engine._baselineStats = {
    GUT:   { mean: 0.75, sd: 0.05 },
    HEART: { mean: 0.45, sd: 0.08 },
    HEAD:  { mean: 0.73, sd: 0.20 },
    [targetRegime]: { mean: baselineRegimeMean, sd: 0.05 },
  };
  engine._targetRegime = targetRegime;
  engine._targetRegimeAttempts = attempts;
  engine._targetRegimeCoherenceMeans = coherenceMeans.slice();
  engine._targetRegimeCoherencePeaks = coherencePeaks.slice();
  engine._targetRegimePeaks = tcsPeaks.slice();
  return engine;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nSustain-based cross-regime escalation gate (v3):');

test('session-4 profile (HEART baseline 0.445, post-Rx means ~0.40-0.50) → escalates', () => {
  // Session 4 had per-prescription HEART coherence means of roughly:
  //   Rx1 0.416, Rx2 0.364, Rx3 0.348, Rx4 0.382, Rx5 0.478, Rx6 0.498,
  //   Rx7 0.549, Rx8 0.548, Rx9 0.482, Rx10 0.510
  // Rolling mean of last 3 means (Rx2-Rx4) = (0.364+0.348+0.382)/3 = 0.365.
  // Sustain floor = 0.445 + 0.10 = 0.545. 0.365 < 0.545 → escalate.
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.445,
    attempts: 4,
    coherenceMeans: [0.416, 0.364, 0.348, 0.382], // session-4 first 4 Rx
  });
  assert.equal(engine._shouldEscalateRegime(), true);
});

test('regime that IS sustaining (climb above baseline + delta) → does not escalate', () => {
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.45,
    attempts: 4,
    coherenceMeans: [0.52, 0.58, 0.61, 0.59], // last 3 mean 0.593, floor 0.55 → hold
  });
  assert.equal(engine._shouldEscalateRegime(), false);
});

test('mixed session — early flat then later climb — does not escalate if last N means clear floor', () => {
  // Only the trailing window counts. Early failures are forgiven once the
  // user actually starts entraining.
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.45,
    attempts: 6,
    coherenceMeans: [0.42, 0.41, 0.43, 0.58, 0.60, 0.62], // last 3 mean 0.60
  });
  assert.equal(engine._shouldEscalateRegime(), false);
});

test('below attempts threshold → does not escalate regardless of means', () => {
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.45,
    attempts: 2,
    coherenceMeans: [0.10, 0.05],
  });
  assert.equal(engine._shouldEscalateRegime(), false);
});

test('regime coherence means empty → does not escalate (safety)', () => {
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.45,
    attempts: 3,
    coherenceMeans: [],
  });
  assert.equal(engine._shouldEscalateRegime(), false);
});

test('baseline stats missing → does not escalate (safety)', () => {
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.45,
    attempts: 4,
    coherenceMeans: [0.20, 0.22, 0.18, 0.21],
  });
  engine._baselineStats = null;
  assert.equal(engine._shouldEscalateRegime(), false);
});

test('configurable delta: raising regime_exhaustion_mean_delta makes escalation stricter', () => {
  const engine = mkEngine({
    targetRegime: 'HEART',
    baselineRegimeMean: 0.45,
    attempts: 4,
    coherenceMeans: [0.55, 0.58, 0.56, 0.57], // last 3 mean 0.570
  });
  engine.config = { ...config, regime_exhaustion_mean_delta: 0.20 };
  // floor = 0.45 + 0.20 = 0.65. 0.570 < 0.65 → escalate.
  assert.equal(engine._shouldEscalateRegime(), true);
  engine.config = { ...config, regime_exhaustion_mean_delta: 0.05 };
  // floor = 0.45 + 0.05 = 0.50. 0.570 >= 0.50 → hold.
  assert.equal(engine._shouldEscalateRegime(), false);
});

console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
