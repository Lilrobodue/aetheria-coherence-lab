// Regression test for the BCS phase-transition hysteresis detector added
// 2026-04-24. The previous stateless detector scanned a rolling history for
// any 15-point jump; once such a jump landed in the window it stayed "detected"
// for the window's lifetime (~33 min), so an April 24 session with BCS
// oscillating between 40 and 70 reported PT on 41 of 48 samples despite
// dropping below 42 twelve times.
//
// New semantics: PT is a STATE, not an EVENT.
//   - fires after PT_FIRE_COUNT consecutive samples above PT_FIRE_THRESHOLD
//   - clears after PT_CLEAR_COUNT consecutive samples below PT_CLEAR_THRESHOLD
//   - asymmetric (fire eagerly, clear reluctantly)
//
// Run: node tests/phase-transition-hysteresis.test.mjs

import assert from 'node:assert/strict';
import {
  PhaseTransitionDetector,
  PT_FIRE_THRESHOLD,
  PT_CLEAR_THRESHOLD,
  PT_FIRE_COUNT,
  PT_CLEAR_COUNT,
} from '../src/bcs/phase-transition.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\nPhaseTransitionDetector hysteresis:');

test('constants have expected values', () => {
  assert.equal(PT_FIRE_THRESHOLD, 60);
  assert.equal(PT_CLEAR_THRESHOLD, 50);
  assert.equal(PT_FIRE_COUNT, 2);
  assert.equal(PT_CLEAR_COUNT, 3);
});

test('starts inactive, window=0', () => {
  const d = new PhaseTransitionDetector();
  assert.equal(d.active, false);
  assert.equal(d.window, 0);
});

test('single spike above threshold does NOT fire (needs 2 consecutive)', () => {
  const d = new PhaseTransitionDetector();
  const s = d.update(65);
  assert.equal(s.active, false);
  assert.equal(s.justFired, false);
  // One dip resets the counter; next above-threshold starts fresh.
  d.update(40);
  d.update(65);
  assert.equal(d.active, false, 'single spike after reset should not fire either');
});

test('two consecutive above fire threshold → fires', () => {
  const d = new PhaseTransitionDetector();
  d.update(65, 10);
  const s = d.update(62, 20);
  assert.equal(s.active, true);
  assert.equal(s.justFired, true);
  assert.equal(s.window, 1);
  assert.equal(s.durationTicks, 1);
  assert.equal(s.fireTime, 20);
});

test('once active, single dip below clear threshold does NOT clear (needs 3)', () => {
  const d = new PhaseTransitionDetector();
  d.update(65); d.update(62); // fire
  d.update(40);
  assert.equal(d.active, true, 'dip 1 must not clear');
  d.update(40);
  assert.equal(d.active, true, 'dip 2 must not clear');
  d.update(40);
  assert.equal(d.active, false, 'dip 3 clears');
});

test('intervening above-clear reading resets the clear counter', () => {
  const d = new PhaseTransitionDetector();
  d.update(65); d.update(62);        // fire
  d.update(40); d.update(40);         // 2 below
  d.update(55);                       // NOT below clear → resets below counter
  d.update(40); d.update(40);         // only 2 below again
  assert.equal(d.active, true, 'incomplete streaks should not clear');
  d.update(40);                       // 3rd consecutive now
  assert.equal(d.active, false);
});

test('April 24 oscillation pattern: PT fires on sustained high, does not spuriously clear', () => {
  const d = new PhaseTransitionDetector();
  // Reproduction of observed sequence around t=79.7s: one spike, then chaos.
  const seq = [62, 73.8, 41.8, 69.6, 43.3, 67.8, 43.4];
  // With the hysteresis model:
  //   62  → above, count=1
  //   73  → above, count=2 → FIRE. active=true.
  //   41  → below clear (50), belowCount=1
  //   69  → above; resets below counter. still active (durationTicks++)
  //   43  → below, belowCount=1
  //   67  → above; resets. still active
  //   43  → below, belowCount=1
  // Stays active because no 3 consecutive below happen. This is the
  // "reluctant clear" behavior — correct per design: once entered, the
  // transition persists unless the exit is genuine (3x ~30s below clear).
  let active = false;
  for (const v of seq) active = d.update(v).active;
  assert.equal(active, true, 'oscillation without 3-consecutive-below should preserve active state');
  // After the last "43.4" tick, below-counter sits at 1. Apply 2 more below-
  // clear samples — the clear fires on the 2nd of those two (belowCount=3).
  d.update(30); // belowCount=2
  const clearState = d.update(30); // belowCount=3 → CLEAR
  assert.equal(clearState.active, false, 'sustained below should eventually clear');
  assert.equal(clearState.justCleared, true);
});

test('sustained genuine PT window reports increasing durationTicks', () => {
  const d = new PhaseTransitionDetector();
  d.update(65); d.update(65); // fire (durationTicks=1 at fire)
  assert.equal(d.update(65).durationTicks, 2);
  assert.equal(d.update(65).durationTicks, 3);
  assert.equal(d.update(65).durationTicks, 4);
});

test('second fire-clear cycle increments window counter', () => {
  const d = new PhaseTransitionDetector();
  d.update(65); d.update(65);          // fire window 1
  d.update(40); d.update(40); d.update(40); // clear
  assert.equal(d.active, false);
  d.update(65); const s = d.update(65); // fire window 2
  assert.equal(s.window, 2);
  assert.equal(s.justFired, true);
});

test('null BCS (no measurement) does not progress or reset counters', () => {
  const d = new PhaseTransitionDetector();
  d.update(65);                         // count=1
  d.update(null);                       // ignored
  const s = d.update(65);               // count=2 → fire
  assert.equal(s.active, true);
  // After firing, null ticks advance duration but don't affect clear detection.
  const s2 = d.update(null);
  assert.equal(s2.active, true);
  assert.equal(s2.durationTicks, 2);
});

test('reset() clears all state', () => {
  const d = new PhaseTransitionDetector();
  d.update(65); d.update(65);
  assert.equal(d.active, true);
  d.reset();
  assert.equal(d.active, false);
  assert.equal(d.window, 0);
});

test('fireTime and clearTime get populated with provided timestamps', () => {
  const d = new PhaseTransitionDetector();
  d.update(65, 100); d.update(65, 110); // fire at t=110
  d.update(40, 120); d.update(40, 130); d.update(40, 140); // clear at t=140
  const s = d.update(50, 150);
  assert.equal(s.fireTime, 110);
  assert.equal(s.clearTime, 140);
});

console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
