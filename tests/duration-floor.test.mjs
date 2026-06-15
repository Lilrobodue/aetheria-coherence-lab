// Tests for the minimum-dose duration floor (multi-app update).
// The policy engine must not auto-close before the target regime's protocol
// minimum, and a non-converging session runs to the regime optimal rather than
// a flat 15-min net. Reproduces the HEART session that was cut short at 15:56.
//
// Run: node tests/duration-floor.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

import { PolicyEngine } from '../src/policy/state-machine.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(here, '../src/config/policy.json'), 'utf8'));

function makeBus() { return { publish() {}, subscribe() { return () => {}; } }; }

function engineAt(sessionDurationSec, targetRegime) {
  const e = new PolicyEngine(makeBus(), config, []);
  e._sessionStart = (performance.now() / 1000) - sessionDurationSec;
  e._targetRegime = targetRegime || null;
  return e;
}

// Capture the close reason without entering the real CLOSING state.
function termination(engine, V) {
  let reason = null;
  const orig = engine._enterClosing.bind(engine);
  engine._enterClosing = (r) => { reason = r; };
  const closed = engine._checkTermination(V || { tcs: 30 });
  engine._enterClosing = orig;
  return { closed, reason };
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('duration-floor.test.mjs');

// ---------- protocol table ----------
test('regime protocol maps HEART to 25/30 min in seconds', () => {
  const e = engineAt(0, 'HEART');
  assert.deepEqual(e._regimeProtocol(), { min: 1500, optimal: 1800 });
});

test('regime protocol maps GUT and HEAD', () => {
  assert.deepEqual(engineAt(0, 'GUT')._regimeProtocol(), { min: 2400, optimal: 2700 });
  assert.deepEqual(engineAt(0, 'HEAD')._regimeProtocol(), { min: 900, optimal: 1200 });
});

test('no target regime falls back to flat session_min/max', () => {
  const e = engineAt(0, null);
  assert.deepEqual(e._regimeProtocol(), {
    min: config.session_min_duration_sec,
    optimal: config.session_max_duration_sec,
  });
});

// ---------- minimum-dose floor ----------
test('minDoseElapsed false before HEART minimum, true after', () => {
  assert.equal(engineAt(1000, 'HEART')._minDoseElapsed(), false);
  assert.equal(engineAt(1600, 'HEART')._minDoseElapsed(), true);
});

// ---------- regression: the exact session that was cut short ----------
test('HEART session at 956s does NOT hit the cap (was guillotined at 900s)', () => {
  // The reported session ran 15:56 (956s) and was force-closed by the old
  // 900s net. Under the floor, neither the cap (1800s) nor goal fires here.
  const { closed } = termination(engineAt(956, 'HEART'), { tcs: 35 });
  assert.equal(closed, false, 'session should be allowed to continue past 900s');
});

test('HEART non-converging session closes at the 30-min optimal', () => {
  const { closed, reason } = termination(engineAt(1850, 'HEART'), { tcs: 35 });
  assert.equal(closed, true);
  assert.match(reason, /Protocol optimal/);
  assert.match(reason, /HEART/);
  assert.match(reason, /1800s/);
});

test('GUT non-converging session runs to 45 min, not 15', () => {
  assert.equal(termination(engineAt(1000, 'GUT'), { tcs: 30 }).closed, false);
  assert.equal(termination(engineAt(1600, 'GUT'), { tcs: 30 }).closed, false); // past HEART min, still < GUT min
  assert.equal(termination(engineAt(2750, 'GUT'), { tcs: 30 }).closed, true);  // ≥ GUT optimal 2700
});

// ---------- goal closer is gated behind the minimum dose ----------
test('goal-reached cannot fire before the regime minimum', () => {
  const e = engineAt(1000, 'HEART'); // below 1500 min
  const { closed } = termination(e, { tcs: 100 });
  assert.equal(closed, false, 'TCS 100 must not close before min dose');
  assert.equal(e._goalSustainStart, null, 'goal sustain timer should not start below min dose');
});

test('goal-reached timer starts once past the minimum dose', () => {
  const e = engineAt(1600, 'HEART'); // past 1500 min, below 1800 optimal
  const { closed } = termination(e, { tcs: 100 });
  assert.equal(closed, false, 'first tick only arms the 60s sustain timer');
  assert.ok(e._goalSustainStart != null, 'goal sustain timer armed past min dose');
});

console.log();
if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('all duration-floor tests passed');
