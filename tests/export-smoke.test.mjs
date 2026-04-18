// Smoke test for the export pipeline (Items 2 + 3 of pre-live verification).
// Publishes mock events to a synthetic bus, captures a full session via
// SessionRecorder.toJSON(), passes the result to buildTaggerExport(), then
// inspects both outputs for:
//   - presence of bcs_value_quality, bcs_shared_energy_quality fields
//   - presence of bcs_sample_count / bcs_gap_count (tagger only)
//   - null serialization (null, not 0, not omitted)
//   - close-rule reason strings contain their diagnostic fields and do NOT
//     contain "undefined" or "NaN" literals
//
// Run: node tests/export-smoke.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { SessionRecorder } from '../src/recording/session-recorder.js';
import { buildTaggerExport } from '../src/recording/tagger-export.js';
import { PolicyEngine } from '../src/policy/state-machine.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(here, '../src/config/policy.json'), 'utf8'));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

// ---------- Synthetic bus ----------
function makeBus() {
  const subs = new Map();
  return {
    publish(topic, payload) {
      const list = subs.get(topic) || [];
      for (const fn of list) fn(payload);
    },
    subscribe(topic, fn) {
      if (!subs.has(topic)) subs.set(topic, []);
      subs.get(topic).push(fn);
      return () => {
        const list = subs.get(topic);
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    }
  };
}

// ---------- Mock 30s session ----------
// Publishes a heterogeneous BCS stream: valid full-quality samples, a Path A
// null with low_variance quality, a Path D null with nan_guard, and a
// legitimate Path C zero with quality='ok'. Covers the quality-flag spectrum.
console.log('export-smoke.test.mjs');

const bus = makeBus();
const recorder = new SessionRecorder(bus, 'smoke-session', 'smoke-user');
recorder.start();

const baseTs = performance.now() / 1000 - 30; // anchor 30s in the past
const bcsEvents = [
  { ts: baseTs + 1,  bcs: 72.5, bcsQuality: 'full',        sharedEnergy: 0.88,   sharedEnergyQuality: 'ok' },
  { ts: baseTs + 11, bcs: null, bcsQuality: 'partial',     sharedEnergy: null,   sharedEnergyQuality: 'low_variance' },
  { ts: baseTs + 21, bcs: null, bcsQuality: 'unavailable', sharedEnergy: null,   sharedEnergyQuality: 'nan_guard' },
  { ts: baseTs + 24, bcs: 64.1, bcsQuality: 'full',        sharedEnergy: 0,      sharedEnergyQuality: 'ok' },
  { ts: baseTs + 28, bcs: 73.0, bcsQuality: 'full',        sharedEnergy: 0.91,   sharedEnergyQuality: 'ok' }
];
for (const e of bcsEvents) {
  bus.publish('Aetheria_BCS', {
    timestamp: e.ts,
    bcs: e.bcs,
    bcsQuality: e.bcsQuality,
    kuramoto: 0.97,
    sharedEnergy: e.sharedEnergy,
    sharedEnergyQuality: e.sharedEnergyQuality,
    mutualInfo: 0.14,
    phaseTransition: { detected: false }
  });
}
// A couple of coherence events to keep the tagger export happy
bus.publish('Aetheria_Coherence', { timestamp: baseTs + 5, tcs: 60, gut: 0.5, heart: 0.6, head: 0.7, triunePLV: 0.3, harmonicLock: 0.5 });
bus.publish('Aetheria_Coherence', { timestamp: baseTs + 25, tcs: 75, gut: 0.7, heart: 0.75, head: 0.8, triunePLV: 0.4, harmonicLock: 0.67 });
// One state transition so the tagger's closing_type has something to read
bus.publish('Aetheria_State', { timestamp: baseTs + 28, type: 'state_transition', from: 'EVALUATE', to: 'CLOSING', reason: 'success' });

recorder.stop();
recorder._metadata.startTime = new Date(baseTs * 1000).toISOString();
recorder._metadata.endTime = new Date((baseTs + 30) * 1000).toISOString();
const fullSession = recorder.toJSON();
const taggerExport = buildTaggerExport(fullSession);

// Round-trip the tagger export through JSON to confirm JSON null survives
const taggerJson = JSON.parse(JSON.stringify(taggerExport));

// ---------- Item 2: full-session stream fields ----------
console.log('\n  Item 2 — Download Full Session (streams.bcs):');

test('streams.bcs has per-sample bcsQuality', () => {
  const bcs = fullSession.streams.bcs;
  assert.equal(bcs.length, 5, 'expected 5 samples');
  assert.ok(bcs.every(b => 'bcsQuality' in b), 'every sample carries bcsQuality');
});

test('streams.bcs has per-sample sharedEnergyQuality', () => {
  const bcs = fullSession.streams.bcs;
  assert.ok(bcs.every(b => 'sharedEnergyQuality' in b), 'every sample carries sharedEnergyQuality');
});

test('full-session preserves null (not coerced to 0) for bcs and sharedEnergy', () => {
  const bcs = fullSession.streams.bcs;
  const partialSample = bcs.find(b => b.bcsQuality === 'partial');
  const unavailableSample = bcs.find(b => b.bcsQuality === 'unavailable');
  assert.equal(partialSample.bcs, null, 'partial sample bcs should be null');
  assert.equal(partialSample.sharedEnergy, null, 'partial sample sharedEnergy should be null');
  assert.equal(unavailableSample.bcs, null);
  assert.equal(unavailableSample.sharedEnergy, null);
});

test('full-session preserves legitimate zero (Path C, quality=ok)', () => {
  const bcs = fullSession.streams.bcs;
  const pathC = bcs.find(b => b.sharedEnergy === 0);
  assert.ok(pathC, 'found Path C sample with sharedEnergy=0');
  assert.equal(pathC.sharedEnergyQuality, 'ok', 'quality should be ok for legit zero');
});

// ---------- Item 2: tagger export fields ----------
console.log('\n  Item 2 — Export for Tagger (time_series + summary):');

test('time_series.bcs_value_quality present and length matches bcs_t', () => {
  const ts = taggerJson.time_series;
  assert.ok(Array.isArray(ts.bcs_value_quality), 'bcs_value_quality is an array');
  assert.equal(ts.bcs_value_quality.length, ts.bcs_t.length);
});

test('time_series.bcs_shared_energy_quality present and length matches bcs_t', () => {
  const ts = taggerJson.time_series;
  assert.ok(Array.isArray(ts.bcs_shared_energy_quality));
  assert.equal(ts.bcs_shared_energy_quality.length, ts.bcs_t.length);
});

test('summary contains bcs_sample_count and bcs_gap_count', () => {
  const s = taggerJson.summary;
  assert.equal(s.bcs_sample_count, 5, 'sample count should be 5');
  // 2 samples have sharedEnergy=null (partial + unavailable)
  assert.equal(s.bcs_gap_count, 2, 'gap count should be 2');
});

test('tagger bcs_value and bcs_shared_energy serialize JSON null (not 0)', () => {
  const ts = taggerJson.time_series;
  // Find the index of the "partial" sample in bcs_value_quality
  const partialIdx = ts.bcs_value_quality.indexOf('partial');
  assert.ok(partialIdx >= 0, 'partial quality present');
  assert.equal(ts.bcs_value[partialIdx], null, 'bcs_value is null at partial index');
  assert.equal(ts.bcs_shared_energy[partialIdx], null, 'bcs_shared_energy is null at partial index');
});

test('tagger bcs_shared_energy_quality includes low_variance and nan_guard', () => {
  const ts = taggerJson.time_series;
  const set = new Set(ts.bcs_shared_energy_quality);
  assert.ok(set.has('low_variance'), 'low_variance present');
  assert.ok(set.has('nan_guard'), 'nan_guard present');
  assert.ok(set.has('ok'), 'ok present');
});

test('peak_bcs and mean_bcs exclude null samples from aggregates', () => {
  const s = taggerJson.summary;
  // Valid bcs values in events: 72.5, 64.1, 73.0 → peak 73.0 (rounded to 73.0)
  // mean = (72.5 + 64.1 + 73.0) / 3 ≈ 69.87 (rounded to 69.9)
  assert.ok(Math.abs(s.peak_bcs - 73) < 0.1, `peak_bcs ${s.peak_bcs} ≈ 73`);
  assert.ok(Math.abs(s.mean_bcs - 69.9) < 0.2, `mean_bcs ${s.mean_bcs} ≈ 69.9`);
});

// ---------- Item 3: close-rule reason strings ----------
console.log('\n  Item 3 — Close-rule reason-string diagnostics:');

function runEngineAndCaptureReason(setupFn) {
  const bus = makeBus();
  const engine = new PolicyEngine(bus, config, []);
  let reason = null;
  engine._enterClosing = (r) => { reason = r; };
  setupFn(engine);
  if (!reason) engine._checkUnifiedCoherence();
  if (!reason) engine._checkSustainedPeak();
  if (!reason) engine._checkStagnation();
  return reason;
}

test('UNIFIED_COHERENCE reason has all diagnostic fields populated', () => {
  const reason = runEngineAndCaptureReason((e) => {
    e._baselineTcsMean = 58; e._baselineTcsStd = 7;
    e._sessionStart = (performance.now() / 1000) - 400;
    const peaks = [75, 72, 78, 76, 77, 76];
    for (const p of peaks) {
      e._frequencyHistory.push({ frequency_hz: 100 });
      e._prescriptionPeaks.push(p);
      if (p > e._sessionMaxTcs) e._sessionMaxTcs = p;
    }
    for (let i = 0; i < 15; i++) {
      e._bcsSamples.push({ t: 280 + i * 8, bcs: 75, bcsQuality: 'full' });
    }
  });
  assert.ok(reason, 'UNIFIED_COHERENCE should fire');
  assert.match(reason, /unified coherence held/);
  assert.match(reason, /TCS sustained=2\/2/);
  assert.match(reason, /BCS valid=\d+/);
  assert.match(reason, /BCS above-threshold=\d+\/\d+/);
  assert.match(reason, /session_max_tcs=\d+(\.\d+)?/);
  assert.match(reason, /bcs_mean=\d+(\.\d+)?/);
  assert.doesNotMatch(reason, /undefined|NaN/);
});

test('SUSTAINED_PEAK reason has session_max, trailing_max, recent_peaks', () => {
  const reason = runEngineAndCaptureReason((e) => {
    e._baselineTcsMean = 62; e._baselineTcsStd = 6;
    e._sessionStart = (performance.now() / 1000) - 400;
    const peaks = [86, 78, 82, 77, 85, 80];
    for (const p of peaks) {
      e._frequencyHistory.push({ frequency_hz: 100 });
      e._prescriptionPeaks.push(p);
      if (p > e._sessionMaxTcs) e._sessionMaxTcs = p;
    }
  });
  assert.ok(reason, 'SUSTAINED_PEAK should fire');
  assert.match(reason, /coherence held/);
  assert.match(reason, /session_max=\d+(\.\d+)?/);
  assert.match(reason, /trailing_max=\d+(\.\d+)?/);
  assert.match(reason, /recent_peaks=\[[\d.,\s]+\]/);
  assert.doesNotMatch(reason, /undefined|NaN/);
});

test('STAGNATION reason has trailing peaks mean, baseline floor, μ, σ, k', () => {
  const reason = runEngineAndCaptureReason((e) => {
    e._baselineTcsMean = 62; e._baselineTcsStd = 6;
    e._sessionStart = (performance.now() / 1000) - 500;
    const peaks = [86, 82, 77, 60, 50, 40];
    for (const p of peaks) {
      e._frequencyHistory.push({ frequency_hz: 100 });
      e._prescriptionPeaks.push(p);
      if (p > e._sessionMaxTcs) e._sessionMaxTcs = p;
    }
  });
  assert.ok(reason, 'STAGNATION should fire');
  assert.match(reason, /destabilized/);
  assert.match(reason, /trailing peaks mean=\d+(\.\d+)?/);
  assert.match(reason, /baseline floor=\d+(\.\d+)?/);
  assert.match(reason, /μ=\d+(\.\d+)?/);
  assert.match(reason, /σ=\d+(\.\d+)?/);
  assert.match(reason, /k=\d+(\.\d+)?/);
  assert.doesNotMatch(reason, /undefined|NaN/);
});

console.log();
if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('all smoke tests passed');
