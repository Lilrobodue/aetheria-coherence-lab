// Tests for the shared IntervalAnalysis module (multi-app spec, Phase 1).
// Verifies the module's own self-test plus the explicit test cases the spec
// lists for cross-app consistency.
//
// Run: node tests/interval-analysis.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// UMD module: no import/export syntax → Node loads it as CommonJS and we read
// module.exports. (In the browser the same file attaches window.IntervalAnalysis.)
const IA = require('../src/lib/interval-analysis.js');

console.log('interval-analysis.test.mjs');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

// ---------- module self-test ----------
test('module self-test reports all passing', () => {
  const r = IA.selfTest();
  assert.equal(r.failed, 0, `self-test failures: ${JSON.stringify(r.results.filter(x => !x.pass))}`);
  assert.ok(r.total >= 8, 'expected at least 8 self-test checks');
});

// ---------- spec Phase 1 explicit cases ----------
test('digitalRoot(528) === 6', () => assert.equal(IA.digitalRoot(528), 6));
test('digitalRoot(174) === 3', () => assert.equal(IA.digitalRoot(174), 3));
test('is369(963) === true', () => assert.equal(IA.is369(963), true));
test('is369(440) === false', () => assert.equal(IA.is369(440), false));
test('couldBeAetheria(528) === true', () => assert.equal(IA.couldBeAetheria(528), true));
test('couldBeAetheria(440) === false', () => assert.equal(IA.couldBeAetheria(440), false));

test('isAetheriaInterval(111) matches GUT base', () => {
  const r = IA.isAetheriaInterval(111);
  assert.equal(r.match, true);
  assert.equal(r.regime, 'GUT');
  assert.equal(r.base, 111);
});

test('isHarmonicRatio(2.0) is octave', () => {
  const r = IA.isHarmonicRatio(2.0);
  assert.equal(r.match, true);
  assert.equal(r.name, 'octave');
});

// ---------- analyzeIntervals on Aetheria GUT peaks scores high ----------
test('Aetheria GUT seed peaks score as tuned with high 3-6-9 ratio', () => {
  const peaks = [174, 285, 396, 528, 639].map(hz => ({ hz }));
  const out = IA.analyzeIntervals(peaks);
  assert.ok(out.coherenceScore >= 50, `coherence ${out.coherenceScore} should be >= 50`);
  assert.ok(out.fingerprint.ratio369 >= 0.5, `3-6-9 ratio ${out.fingerprint.ratio369} should be >= 0.5`);
  assert.ok(out.fingerprint.aetheriaMatches >= 1, 'expected Aetheria interval matches');
});

// ---------- recommendDuration / evaluateDuration ----------
test('recommendDuration resolves walk display names', () => {
  assert.equal(IA.recommendDuration('GUT', 'Flying Star Vortex').optimal, IA.DURATION_PROTOCOL.VORTEX.optimal);
  assert.equal(IA.recommendDuration('HEAD').optimal, IA.DURATION_PROTOCOL.HEAD.optimal);
});

test('evaluateDuration flags short and optimal GUT sessions', () => {
  assert.equal(IA.evaluateDuration('GUT', 15).met, false);
  assert.equal(IA.evaluateDuration('GUT', 45).status, 'optimal');
  assert.equal(IA.evaluateDuration('GUT', 200).status, 'extended');
});

console.log();
if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('all interval-analysis tests passed');
