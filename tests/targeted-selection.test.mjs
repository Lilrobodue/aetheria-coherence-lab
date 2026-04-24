// Targeted-selection regression tests (spec §4).
// Tests that classification + regime-targeted selection together deliver on
// the gap identified in the April 24 session: baseline classified correctly
// but prescription still defaulted to a GUT cascade.
//
// Run: node tests/targeted-selection.test.mjs
// Exits non-zero on assertion failure.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

import {
  classify, deficitRegime, CLASSIFICATIONS, DEFAULT_CLASSIFIER_CONFIG,
} from '../src/policy/baseline-classifier.js';
import { summarizeBaseline } from '../src/policy/baseline-stats.js';
import {
  deficitProtocol,
  reinforcementProtocol,
  maintenanceProtocol,
  foundationProtocol,
  runProtocol,
  resolveTargetRegime,
  selectCrossRegimeEscalation,
  selectClosingBridge,
} from '../src/policy/protocols.js';

const here = dirname(fileURLToPath(import.meta.url));
const FREQ_LIB = JSON.parse(
  readFileSync(resolve(here, '../src/config/frequencies.json'), 'utf8')
);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ---------------------------------------------------------------------------
console.log('\n§4.1 — baseline classification preserved:');

const apr24Path = resolve(here, '..', 'Joe-solo-aetheria-session-2026-04-24_1777013238545.json');
const apr19Path = resolve(here, '..', 'Joe-solo-aetheria-session-2026-04-19_1776604171160.json');

function loadBaselineStats(sessionPath, baselineEndT) {
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const coh = session.streams.coherence
    .filter(s => s.t < baselineEndT)
    .map(s => ({
      t: s.t, gut: s.gut, heart: s.heart, head: s.head,
      harm: s.harm, triunePLV: s.plv, deficit: s.deficit,
    }));
  const feats = session.streams.features
    .filter(s => s.t < baselineEndT)
    .map(f => ({ t: f.t, heart: f.heart, gut: f.gut, head: f.head, resp: f.resp }));
  const bcs = session.streams.bcs
    .filter(s => s.t < baselineEndT)
    .map(s => ({ t: s.t, kuramoto: s.kuramoto }));
  return summarizeBaseline(coh, feats, bcs, { durationSec: baselineEndT });
}

if (!existsSync(apr24Path)) {
  console.log('  ⊘ April 24 JSON missing — skipping');
} else {
  const stats = loadBaselineStats(apr24Path, 91);

  test('baseline stats: GUT≈0.79, HEART≈0.44, HEAD≈0.77', () => {
    assert.ok(Math.abs(stats.GUT.mean   - 0.79) < 0.02, `GUT.mean=${stats.GUT.mean}`);
    assert.ok(Math.abs(stats.HEART.mean - 0.44) < 0.02, `HEART.mean=${stats.HEART.mean}`);
    assert.ok(Math.abs(stats.HEAD.mean  - 0.77) < 0.05, `HEAD.mean=${stats.HEAD.mean}`);
  });

  test('classification on April 24 baseline → mixed', () => {
    const c = classify(stats);
    assert.equal(c, CLASSIFICATIONS.MIXED, `got ${c}`);
  });

  test('deficit_majority on April 24 baseline → HEART', () => {
    assert.equal(stats.deficit_majority, 'HEART', `got ${stats.deficit_majority}`);
    assert.ok(stats.deficit_votes.HEART > stats.deficit_votes.NONE,
      `expected HEART votes > NONE votes, got ${JSON.stringify(stats.deficit_votes)}`);
  });
}

if (existsSync(apr19Path)) {
  test('April 19 session still recognizable after classifier tightening (no regression)', () => {
    const stats = loadBaselineStats(apr19Path, 94);
    // April 19 HEAD.sd=0.24 was 1 noisy regime — under new defaults, NOT unstable.
    // Falls through to mixed (HEART.mean=0.57 below 0.70 regulated floor).
    const c = classify(stats);
    assert.equal(c, CLASSIFICATIONS.MIXED, `got ${c} — April 19 should be MIXED under tightened rule`);
  });
}

// ---------------------------------------------------------------------------
console.log('\n§4.2 — first prescription targets HEART deficit, not GUT:');

function mkBaseline({ deficitMajority = 'HEART' } = {}) {
  return {
    GUT:   { mean: 0.79, sd: 0.05 },
    HEART: { mean: 0.44, sd: 0.06 },
    HEAD:  { mean: 0.76, sd: 0.235 },
    spin_strength_peak: 0.2,
    deficit_majority: deficitMajority,
    deficit_votes: { GUT: 0, HEART: 59, HEAD: 0, NONE: 32 },
  };
}

test('deficitProtocol first-prescription from mixed+HEART baseline → HEART frequency', () => {
  const ctx = {
    classification: CLASSIFICATIONS.MIXED,
    baseline: mkBaseline(),
    coherence: { gut: 0.79, heart: 0.44, head: 0.76, deficit: 'NONE', lead: 'GUT' },
    history: [],
    library: FREQ_LIB,
    targetRegime: 'HEART',
  };
  const pick = deficitProtocol(ctx);
  assert.ok(pick, 'expected a prescription');
  assert.equal(pick.freq.regime, 'HEART', `got ${pick.freq.regime}`);
  assert.ok([1206, 1449, 1692].includes(pick.freq.frequency_hz),
    `expected an opening HEART frequency, got ${pick.freq.frequency_hz}`);
  assert.equal(pick.target_regime, 'HEART');
  assert.ok(pick.selection_rationale.includes('HEART'));
  assert.ok(pick.candidate_pool.length >= 3, 'candidate pool should list HEART options');
});

test('live coherence.deficit=NONE does not break HEART targeting', () => {
  // This is the exact April 24 failure mode: deficit fluctuates to NONE on the
  // tick the engine samples, so the old logic picked GUT. Cached target wins.
  const ctx = {
    classification: CLASSIFICATIONS.MIXED,
    baseline: mkBaseline(),
    coherence: { gut: 0.79, heart: 0.44, head: 0.76, deficit: 'NONE', lead: 'GUT' },
    history: [],
    library: FREQ_LIB,
    targetRegime: 'HEART',
  };
  const pick = deficitProtocol(ctx);
  assert.equal(pick.freq.regime, 'HEART');
});

test('resolveTargetRegime prefers baseline.deficit_majority over live deficit', () => {
  const baseline = mkBaseline();
  const live = { deficit: 'NONE', lead: 'GUT' };
  assert.equal(resolveTargetRegime(baseline, CLASSIFICATIONS.MIXED, live), 'HEART');
});

test('summarizeBaseline counts deficit votes when samples carry a `deficit` field', () => {
  // Regression guard: a baseline-sample buffer that omits `deficit` will
  // silently produce deficit_votes=0 across the board and deficit_majority=null.
  // That broke the Joe-new-solo 2026-04-24 session metadata.
  const coh = [
    { t: 0, gut: 0.8, heart: 0.4, head: 0.7, deficit: 'HEART' },
    { t: 1, gut: 0.8, heart: 0.4, head: 0.7, deficit: 'HEART' },
    { t: 2, gut: 0.8, heart: 0.4, head: 0.7, deficit: 'NONE'  },
    { t: 3, gut: 0.8, heart: 0.4, head: 0.7, deficit: 'HEART' },
  ];
  const stats = summarizeBaseline(coh, [], [], { durationSec: 3 });
  assert.equal(stats.deficit_votes.HEART, 3);
  assert.equal(stats.deficit_votes.NONE, 1);
  assert.equal(stats.deficit_majority, 'HEART');
});

// ---------------------------------------------------------------------------
console.log('\n§4.3 — pivot stays in HEART until exhausted:');

test('subsequent prescriptions stay in HEART with different frequencies', () => {
  const played = [];
  for (let i = 0; i < 3; i++) {
    const ctx = {
      classification: CLASSIFICATIONS.MIXED,
      baseline: mkBaseline(),
      coherence: { gut: 0.79, heart: 0.44, head: 0.76, deficit: 'HEART', lead: 'GUT' },
      history: played.slice(),
      library: FREQ_LIB,
      targetRegime: 'HEART',
    };
    const pick = deficitProtocol(ctx);
    assert.ok(pick, `iteration ${i}: no pick`);
    assert.equal(pick.freq.regime, 'HEART', `iteration ${i}: regime=${pick.freq.regime}`);
    played.push(pick.freq);
  }
  const hzs = played.map(f => f.frequency_hz);
  assert.equal(new Set(hzs).size, 3, `expected 3 distinct HEART frequencies, got ${hzs.join(',')}`);
});

// ---------------------------------------------------------------------------
console.log('\n§4.4 — cross-regime escalation gated by evidence:');

test('escalation NOT triggered before threshold attempts', () => {
  // Caller (state machine) guards this — protocol trusts that signal.
  // We simulate by calling deficitProtocol with <3 HEART attempts in history.
  const history = [
    FREQ_LIB.find(f => f.frequency_hz === 1206),
    FREQ_LIB.find(f => f.frequency_hz === 1449),
  ];
  const ctx = {
    classification: CLASSIFICATIONS.MIXED,
    baseline: mkBaseline(),
    coherence: { gut: 0.79, heart: 0.44, head: 0.76, deficit: 'HEART', lead: 'GUT' },
    history,
    library: FREQ_LIB,
    targetRegime: 'HEART',
  };
  const pick = deficitProtocol(ctx);
  assert.equal(pick.freq.regime, 'HEART', `expected HEART, got ${pick.freq.regime}`);
});

test('cross-regime escalation from HEART uses the bridge tone 3150 Hz first', () => {
  const history = [
    FREQ_LIB.find(f => f.frequency_hz === 1206),
    FREQ_LIB.find(f => f.frequency_hz === 1449),
    FREQ_LIB.find(f => f.frequency_hz === 1692),
  ];
  const ctx = {
    baseline: mkBaseline(),
    coherence: { deficit: 'HEART', lead: 'GUT' },
    history,
    library: FREQ_LIB,
  };
  const pick = selectCrossRegimeEscalation('HEART', ctx);
  assert.ok(pick, 'expected an escalation pick');
  assert.equal(pick.freq.frequency_hz, 3150, `got ${pick.freq.frequency_hz}`);
  assert.equal(pick.target_regime, 'HEART', 'bridge remains "in" HEART');
  assert.equal(pick.next_regime, 'HEAD');
});

test('cross-regime escalation after bridge moves into HEAD', () => {
  const history = [
    FREQ_LIB.find(f => f.frequency_hz === 1206),
    FREQ_LIB.find(f => f.frequency_hz === 1449),
    FREQ_LIB.find(f => f.frequency_hz === 1692),
    FREQ_LIB.find(f => f.frequency_hz === 3150), // bridge already played
  ];
  const ctx = {
    baseline: mkBaseline(),
    coherence: { deficit: 'HEART', lead: 'GUT' },
    history,
    library: FREQ_LIB,
  };
  const pick = selectCrossRegimeEscalation('HEART', ctx);
  assert.ok(pick, 'expected an escalation pick');
  assert.equal(pick.freq.regime, 'HEAD', `got ${pick.freq.regime}`);
});

test('escalation from GUT uses 963 Hz bridge', () => {
  const ctx = {
    baseline: mkBaseline({ deficitMajority: 'GUT' }),
    coherence: { deficit: 'GUT', lead: 'HEART' },
    history: [174, 285, 396].map(hz => FREQ_LIB.find(f => f.frequency_hz === hz)),
    library: FREQ_LIB,
  };
  const pick = selectCrossRegimeEscalation('GUT', ctx);
  assert.ok(pick);
  assert.equal(pick.freq.frequency_hz, 963);
  assert.equal(pick.next_regime, 'HEART');
});

test('escalation from HEAD returns null → state machine routes to CLOSING', () => {
  const ctx = {
    baseline: mkBaseline(),
    coherence: { deficit: 'HEAD', lead: 'GUT' },
    history: [3504, 3858, 4212].map(hz => FREQ_LIB.find(f => f.frequency_hz === hz)),
    library: FREQ_LIB,
  };
  assert.equal(selectCrossRegimeEscalation('HEAD', ctx), null);
});

// ---------------------------------------------------------------------------
console.log('\n§4.5 — closing bridge selection is deficit-aware:');

test('HEART engaged and improved → close on HEART-9 (3150 Hz integration)', () => {
  const baseline = mkBaseline(); // HEART.mean=0.44
  const live = { gut: 0.78, heart: 0.62, head: 0.72, lead: 'GUT' }; // HEART improved +0.18
  const history = [1206, 1449, 1692].map(hz => FREQ_LIB.find(f => f.frequency_hz === hz));
  const freq = selectClosingBridge({ library: FREQ_LIB, baseline, liveCoherence: live, targetRegime: 'HEART', history });
  assert.ok(freq);
  assert.equal(freq.frequency_hz, 3150, `got ${freq.frequency_hz}`);
});

test('HEART was fresh engagement (not improved) → close on first-order HEART', () => {
  const baseline = mkBaseline();
  const live = { gut: 0.78, heart: 0.45, head: 0.72, lead: 'GUT' }; // HEART ~baseline
  const history = []; // no HEART plays yet
  const freq = selectClosingBridge({ library: FREQ_LIB, baseline, liveCoherence: live, targetRegime: 'HEART', history });
  assert.ok(freq);
  assert.equal(freq.regime, 'HEART');
  assert.equal(freq.frequency_hz, 1206, `got ${freq.frequency_hz}`);
});

test('no target regime → fallback to lead-regime root-9', () => {
  const baseline = mkBaseline();
  const live = { gut: 0.78, heart: 0.62, head: 0.72, lead: 'HEART' };
  const freq = selectClosingBridge({ library: FREQ_LIB, baseline, liveCoherence: live, targetRegime: null, history: [] });
  assert.ok(freq);
  assert.equal(freq.frequency_hz, 3150);
});

// ---------------------------------------------------------------------------
console.log(`\n${failures ? '✗' : '✓'} ${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
