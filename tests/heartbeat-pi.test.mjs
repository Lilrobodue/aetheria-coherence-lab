// Unit tests for the π-timed heartbeat signature cycle plan.
// Verifies: intervals expand by π/e each cycle, amplitudes decay by 1/√π.
//
// Run: node tests/heartbeat-pi.test.mjs

import assert from 'node:assert/strict';
import {
  piTimedCycles,
  PI_OVER_E,
  ONE_OVER_SQRT_PI,
  ONE_OVER_PI,
} from '../src/delivery/heartbeat-signature.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\nπ-timed heartbeat cycle plan:');

test('constants match their definitions', () => {
  assert.ok(approx(PI_OVER_E, Math.PI / Math.E));
  assert.ok(approx(ONE_OVER_SQRT_PI, 1 / Math.sqrt(Math.PI)));
  assert.ok(approx(ONE_OVER_PI, 1 / Math.PI));
});

test('three cycles with intervals forming a π/e geometric sequence', () => {
  const cycles = piTimedCycles(1.0);
  assert.equal(cycles.length, 3);
  assert.ok(approx(cycles[0].interval, 1.0));
  assert.ok(approx(cycles[1].interval, PI_OVER_E));
  assert.ok(approx(cycles[2].interval, PI_OVER_E * PI_OVER_E));
  // Ratios between successive cycles must equal π/e exactly.
  assert.ok(approx(cycles[1].interval / cycles[0].interval, PI_OVER_E));
  assert.ok(approx(cycles[2].interval / cycles[1].interval, PI_OVER_E));
});

test('amplitudes form the 1, 1/√π, 1/π sequence', () => {
  const cycles = piTimedCycles(1.0);
  assert.ok(approx(cycles[0].amplitude, 1.0));
  assert.ok(approx(cycles[1].amplitude, ONE_OVER_SQRT_PI));
  assert.ok(approx(cycles[2].amplitude, ONE_OVER_PI));
  // amplitude[2] = amplitude[1]² (geometric decay by 1/√π per step).
  assert.ok(approx(cycles[2].amplitude, cycles[1].amplitude * cycles[1].amplitude));
});

test('baseInterval scales the whole sequence proportionally', () => {
  const cycles = piTimedCycles(0.7);
  assert.ok(approx(cycles[0].interval, 0.7));
  assert.ok(approx(cycles[1].interval, 0.7 * PI_OVER_E));
  assert.ok(approx(cycles[2].interval, 0.7 * PI_OVER_E * PI_OVER_E));
});

test('total signature duration ≈ 3.49s at default base', () => {
  // For sanity: the three intervals add to 1 + π/e + (π/e)² ≈ 3.493.
  const cycles = piTimedCycles(1.0);
  const total = cycles.reduce((s, c) => s + c.interval, 0);
  assert.ok(approx(total, 1 + PI_OVER_E + PI_OVER_E * PI_OVER_E));
  assert.ok(total > 3.4 && total < 3.6, `got ${total}`);
});

test('intervals are monotonically increasing (slowing, not jarring)', () => {
  const cycles = piTimedCycles(1.0);
  assert.ok(cycles[1].interval > cycles[0].interval);
  assert.ok(cycles[2].interval > cycles[1].interval);
});

test('amplitudes are monotonically decreasing (softening)', () => {
  const cycles = piTimedCycles(1.0);
  assert.ok(cycles[1].amplitude < cycles[0].amplitude);
  assert.ok(cycles[2].amplitude < cycles[1].amplitude);
});

console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
