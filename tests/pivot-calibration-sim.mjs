// Simulation: replay three realistic TCS trajectories through the updated
// prescription engine and report outcomes. Drives the real evaluate() from
// src/policy/evaluate-rules.js, mirroring the state-machine control flow
// (BASELINE -> ENTRAIN -> EVALUATE -> ENTRAIN/ASSESS -> PRESCRIBE loop).
//
// Run:  node tests/pivot-calibration-sim.mjs
//
// Exercises the post-2026-04-17 calibration:
//   Commit 1 — baseline-relative peak threshold
//   Commit 2 — slope-veto on low-confidence pivots
//   Commit 3 — adaptive ENTRAIN window (30s -> 45s)
//   Commit 6 — CLOSE_ON_SUSTAINED_PEAK success rule
//   Commit 7 — CLOSE_ON_STAGNATION (replaces pivot budget)
//   Commit 8 — 15 min time cap safety net
//
// Pre-patch BEFORE run uses absolute 65 threshold, no slope veto, 3-pivot
// budget close, 30 min cap — same as before the first calibration commit.
//
// Commits 4 (pivot_budget) and 5 (phase-transition warmup) are omitted:
// Commit 4's path is removed by Commit 7; Commit 5 lives in bcs-engine.js
// and does not affect policy decisions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { evaluate } from '../src/policy/evaluate-rules.js';
import { mean, std, linearSlope } from '../src/math/stats.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(here, '../src/config/policy.json'), 'utf8'));
const library = JSON.parse(readFileSync(resolve(here, '../src/config/frequencies.json'), 'utf8'));

// ---------- Seeded PRNG (mulberry32) + gaussian ----------
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function freqHash(freq) {
  let h = 0;
  const s = String(freq.frequency_hz);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ---------- Baseline TCS generator ----------
function generateBaseline(profile, rng) {
  const n = config.baseline_duration_sec ?? 90;
  const out = [];
  for (let i = 0; i < n; i++) {
    let v = profile.baselineMean + profile.baselineStd * gaussian(rng);
    v = Math.max(profile.baselineMin, Math.min(profile.baselineMax, v));
    out.push(v);
  }
  return out;
}

// ---------- Per-prescription TCS trajectory ----------
// Shapes:
//   'bumpDecay'      default — gain seeded from freq hash, peaks ~t=10–15, decays
//   'sustainedRise'  Profile B's HEAD special — +7 TCS across 30s, plateaus
//   'riseDipBack'    Profile C's GUT special — rises then dips below peak-10
//                    while remaining overall rising (triggers slope-veto)
function tcsAt(profile, freq, t, rng, shape) {
  const hashRng = mulberry32(freqHash(freq) + profile.seed);
  const gainRoll = hashRng();          // 0..1 — freq's intrinsic response strength
  const gain = gainRoll * 25;          // peak gain 0..25 above baseline mean
  const peakT = 9 + 6 * hashRng();     // peak between t=9..15
  const decayRate = 0.25 + 0.25 * hashRng();

  if (shape === 'sustainedRise') {
    const rate = 7 / 30;
    const plateau = profile.baselineMean + 8;
    const v = t < 30 ? profile.baselineMean + rate * t : plateau;
    return clamp(v + 1.2 * gaussian(rng));
  }
  if (shape === 'riseDipBack') {
    // rise from (mean-5) to (mean+10) across 20s, then dip to (mean-2) by t=30,
    // then settle near baseline. extensionSlope across first 30 stays > +3.
    let v;
    if (t <= 20) v = profile.baselineMean - 5 + (15 / 20) * t;
    else if (t <= 30) v = (profile.baselineMean + 10) + ((profile.baselineMean - 2) - (profile.baselineMean + 10)) * ((t - 20) / 10);
    else v = profile.baselineMean - 2;
    return clamp(v + 1.2 * gaussian(rng));
  }

  const peakVal = profile.baselineMean + gain;
  let v;
  if (t <= peakT) v = profile.baselineMean + gain * (t / peakT);
  else {
    const k = Math.exp(-decayRate * (t - peakT) / 10);
    v = peakVal * k + profile.baselineMean * (1 - k);
  }
  return clamp(v + 1.2 * gaussian(rng));
}
function clamp(v) { return Math.max(0, Math.min(100, v)); }

// ---------- Pre-patch evaluate() for before/after comparison ----------
// Mirrors evaluate-rules.js as of the commit prior to d64b0dc.
// Absolute 65 peak threshold, no slope veto.
function evaluatePrePatch(params, cfg) {
  const { tcsHistory, tcsNow, tcsAtEntry, tcsMaxInState,
          coherenceVector: V, entryVector: V0 } = params;
  const deltaTCS = tcsNow - tcsAtEntry;
  const slope = linearSlope(tcsHistory.slice(-30));
  const advanceDelta = cfg.advance_tcs_delta_threshold ?? 15;
  const advancePlateau = cfg.advance_plateau_tcs_threshold ?? 70;
  const pivotLowPlateau = cfg.pivot_low_plateau_tcs_threshold ?? 50;
  const declineThreshold = cfg.decline_from_peak_threshold ?? 10;
  const slopeThreshold = cfg.plateau_slope_threshold ?? 0.1;

  if (deltaTCS >= advanceDelta && slope >= 0)
    return { decision: 'ADVANCE', reason: 'Strong response' };
  if (tcsNow >= advancePlateau && Math.abs(slope) < slopeThreshold)
    return { decision: 'ADVANCE', reason: 'High plateau' };
  if (tcsNow < pivotLowPlateau && Math.abs(slope) < slopeThreshold && tcsHistory.length >= 30)
    return { decision: 'PIVOT', reason: 'Low plateau' };
  if (tcsNow < tcsMaxInState - declineThreshold) {
    if (tcsMaxInState >= 65)
      return { decision: 'ADVANCE', reason: 'Peak was high, declining' };
    return { decision: 'PIVOT', reason: 'Declining from low peak' };
  }
  if (V.deficit !== V0.deficit && V.deficit !== 'NONE')
    return { decision: 'PIVOT', reason: 'Deficit shift' };
  return { decision: 'HOLD', reason: 'Giving frequency more time' };
}

// ---------- Simple frequency selector ----------
// Not the real CascadeCursor — just rotates regimes on PIVOT, stays in regime
// on ADVANCE. Adequate for exercising the evaluate/state flow.
function makeSelector(library) {
  const regimeOrder = ['GUT', 'HEART', 'HEAD'];
  const byRegime = Object.fromEntries(regimeOrder.map(r => [r, library.filter(f => f.regime === r)]));
  const indices = { GUT: 0, HEART: 0, HEAD: 0 };
  let currentRegime = 'GUT';
  let isFirst = true;
  return {
    next(hint) {
      if (!isFirst && hint === 'PIVOT') {
        currentRegime = regimeOrder[(regimeOrder.indexOf(currentRegime) + 1) % regimeOrder.length];
      }
      isFirst = false;
      const pool = byRegime[currentRegime];
      const f = pool[indices[currentRegime] % pool.length];
      indices[currentRegime]++;
      return f;
    }
  };
}

// ---------- Simulation driver ----------
function runSimulation(baseProfile, label, opts = {}) {
  const { usePrePatchLogic = false } = opts;
  const profile = { ...baseProfile, headRisingFired: false, gutRiseDipFired: false };
  const rng = mulberry32(profile.seed);
  const selector = makeSelector(library);

  const baseline = generateBaseline(profile, rng);
  const stdFloor = config.baseline_tcs_std_floor ?? 3.0;
  const baselineTcsMean = mean(baseline);
  const baselineTcsStd = Math.max(std(baseline), stdFloor);

  const peakK = config.peak_significance_k ?? 1.5;
  const significantPeakValue = usePrePatchLogic ? 65 : (baselineTcsMean + peakK * baselineTcsStd);

  const pivotBudgetOld = 3; // pre-patch only
  const baseMin = config.entrain_min_duration_sec ?? 30;
  const extMin = config.entrain_extended_min_duration_sec ?? 45;
  // pre-patch used the old 30 min cap; new path uses the post-Commit 8 15 min cap
  const maxSession = usePrePatchLogic ? 1800 : (config.session_max_duration_sec ?? 900);
  const declineThreshold = config.decline_from_peak_threshold ?? 10;

  const successMinDur = config.success_min_duration_sec ?? 360;
  const sustainRatio = config.sustain_ratio ?? 0.85;
  const sustainWindows = config.sustain_windows ?? 2;
  const trailingMaxWindows = config.trailing_max_windows ?? 3;
  const stagnationMinRx = config.stagnation_min_prescriptions ?? 6;
  const stagnationWindows = config.stagnation_windows ?? 3;
  const stagnationDeclineRatio = config.stagnation_decline_ratio ?? 0.80;

  const metrics = {
    label,
    profile: profile.name,
    baselineTcsMean: baselineTcsMean.toFixed(1),
    baselineTcsStd: baselineTcsStd.toFixed(1),
    significantPeak: significantPeakValue.toFixed(1),
    sessionDurationSec: 0,
    prescriptionsPlayed: 0,
    pivotCount: 0,
    slopeVetoCount: 0,
    advanceCount: 0,
    holdCount: 0,
    sessionMaxTcs: 0,
    closingRule: null,    // 'SUSTAINED_PEAK' | 'STAGNATION' | 'TIME_CAP' | 'PIVOT_BUDGET'
    closingReason: null,
    timeline: [],
    // Per prescription-end diagnostic of the CLOSE_ON_SUSTAINED_PEAK check:
    // { t, sessionMax, floor, recentPeaks, passed, gatedBy }
    sustainChecks: []
  };

  let sessionT = config.baseline_duration_sec ?? 90;
  let consecutivePivots = 0; // pre-patch only
  let hasPivotedEver = false;
  let sessionMaxTcs = 0;
  const prescriptionPeaks = [];
  let prescriptionOfSessionMax = 0;
  let lastHint = 'PIVOT';
  let closed = false;

  function closeWith(rule, reason) {
    metrics.closingRule = rule;
    metrics.closingReason = reason;
    closed = true;
  }

  prescriptionLoop:
  while (sessionT < maxSession && !closed) {
    const freq = selector.next(lastHint);
    metrics.prescriptionsPlayed++;
    let shape = 'bumpDecay';
    if (!usePrePatchLogic && profile.specialHeadRising && freq.regime === 'HEAD' && !profile.headRisingFired) {
      shape = 'sustainedRise';
      profile.headRisingFired = true;
    } else if (profile.specialHeadRising && freq.regime === 'HEAD' && usePrePatchLogic && !profile._bHeadSeen) {
      // same override in pre-patch run so comparison is apples-to-apples
      shape = 'sustainedRise';
      profile._bHeadSeen = true;
    }
    if (!usePrePatchLogic && profile.specialGutRiseDip && freq.regime === 'GUT' && !profile.gutRiseDipFired) {
      shape = 'riseDipBack';
      profile.gutRiseDipFired = true;
    } else if (profile.specialGutRiseDip && freq.regime === 'GUT' && usePrePatchLogic && !profile._cGutSeen) {
      shape = 'riseDipBack';
      profile._cGutSeen = true;
    }

    // Fresh prescription — reset ENTRAIN-local state
    let slopeVetoUsed = false;
    let inExtension = false;
    let tcsHistory = [];
    let tcsAtEntry = null;
    let tcsMaxInState = 0;
    let t = 0;
    let prescriptionSummary = { freq: freq.frequency_hz, regime: freq.regime, shape, decisions: [] };

    // ENTRAIN/EVALUATE inner loop — mirrors state-machine.js _tickEntrain
    // termination: evaluate after minDur AND (plateau | decline > threshold | maxDur)
    const maxDur = config.entrain_max_duration_sec ?? 180;
    const slopeThreshold = config.plateau_slope_threshold ?? 0.1;
    while (true) {
      const minDur = usePrePatchLogic ? baseMin : ((inExtension || hasPivotedEver) ? extMin : baseMin);
      const windowStartT = t;
      // Generate samples until termination conditions match
      while (t - windowStartT < maxDur) {
        const tcs = tcsAt(profile, freq, t, rng, shape);
        tcsHistory.push(tcs);
        if (tcsAtEntry === null) tcsAtEntry = tcs;
        if (tcs > tcsMaxInState) tcsMaxInState = tcs;
        t++;
        sessionT++;
        if (sessionT >= maxSession) {
          closeWith('TIME_CAP', usePrePatchLogic ? 'Time cap reached' : 'Time cap reached (safety net)');
          break;
        }
        const windowDur = t - windowStartT;
        if (windowDur < minDur) continue;
        const slope15 = tcsHistory.length >= 15
          ? Math.abs(tcsHistory.slice(-15).reduce((a, b) => a + b, 0) / 15 - tcs)
          : 1;
        const plateauOK = slope15 < slopeThreshold && windowDur >= minDur + 15;
        const declineOK = tcs < tcsMaxInState - declineThreshold;
        const maxOK = windowDur >= maxDur;
        if (plateauOK || declineOK || maxOK) break;
      }
      if (closed) break;

      const V = { tcs: tcsHistory.at(-1), lead: freq.regime, deficit: 'NONE' };
      const V0 = { tcs: tcsAtEntry, lead: freq.regime, deficit: 'NONE' };
      const params = {
        tcsHistory, tcsNow: V.tcs, tcsAtEntry, tcsMaxInState,
        coherenceVector: V, entryVector: V0,
        baselineTcsMean, baselineTcsStd,
        slopeVetoAvailable: !slopeVetoUsed
      };
      const result = usePrePatchLogic
        ? evaluatePrePatch(params, config)
        : evaluate(params, config);

      prescriptionSummary.decisions.push({
        t: sessionT,
        tcsNow: V.tcs.toFixed(1),
        tcsMax: tcsMaxInState.toFixed(1),
        decision: result.decision,
        veto: !!result.appliedSlopeVeto,
        reason: result.reason
      });

      // Counters (match state-machine.js)
      if (result.decision === 'PIVOT') {
        hasPivotedEver = true;
        metrics.pivotCount++;
        if (usePrePatchLogic) consecutivePivots++;
      } else if (usePrePatchLogic) {
        consecutivePivots = 0;
      }
      if (result.decision === 'ADVANCE') metrics.advanceCount++;
      if (result.decision === 'HOLD' && !result.appliedSlopeVeto) metrics.holdCount++;
      if (result.appliedSlopeVeto) metrics.slopeVetoCount++;

      // Pre-patch closing: consecutive pivot budget (3)
      if (usePrePatchLogic && consecutivePivots >= pivotBudgetOld) {
        closeWith('PIVOT_BUDGET', `${pivotBudgetOld} consecutive pivots — diminishing returns`);
        break;
      }

      // New-logic closing: on prescription end, check sustained-peak then stagnation
      if (!usePrePatchLogic && (result.decision === 'PIVOT' || result.decision === 'ADVANCE')) {
        prescriptionPeaks.push(tcsMaxInState);
        if (tcsMaxInState > sessionMaxTcs) {
          sessionMaxTcs = tcsMaxInState;
          prescriptionOfSessionMax = metrics.prescriptionsPlayed;
        }

        // Diagnostic: record the SUSTAINED_PEAK evaluation regardless of outcome.
        // Commit 10: sustain floor uses trailing_max (last N prescriptions) rather
        // than all-time session_max_tcs. Significance gate still uses session_max.
        const recent = prescriptionPeaks.slice(-sustainWindows);
        const trailing = prescriptionPeaks.slice(-trailingMaxWindows);
        const trailingMax = trailing.length >= trailingMaxWindows
          ? Math.max(...trailing)
          : sessionMaxTcs;
        const floor = sustainRatio * trailingMax;
        let sustainPassed = false;
        let gatedBy = null;
        if (sessionT < successMinDur) gatedBy = 'min-duration';
        else if (sessionMaxTcs <= significantPeakValue) gatedBy = 'peak-below-threshold';
        else if (recent.length < sustainWindows) gatedBy = 'not-enough-peaks';
        else if (!recent.every(p => p >= floor)) gatedBy = 'peak-below-floor';
        else { sustainPassed = true; gatedBy = 'passed'; }

        metrics.sustainChecks.push({
          t: sessionT,
          rx: metrics.prescriptionsPlayed,
          sessionMax: sessionMaxTcs,
          trailingMax,
          floor,
          recentPeaks: recent.slice(),
          passed: sustainPassed,
          gatedBy
        });

        // CLOSE_ON_SUSTAINED_PEAK
        if (sustainPassed) {
          const recentStr = recent.map(p => p.toFixed(1)).join(', ');
          closeWith('SUSTAINED_PEAK',
            `coherence held — closing on peak (session_max=${sessionMaxTcs.toFixed(1)}, trailing_max=${trailingMax.toFixed(1)}, recent_peaks=[${recentStr}])`);
          break;
        }

        // CLOSE_ON_STAGNATION (9a: require declining peaks; 9c: duration gate)
        const rxSincePeak = metrics.prescriptionsPlayed - prescriptionOfSessionMax;
        if (
          sessionT >= successMinDur &&
          metrics.prescriptionsPlayed >= stagnationMinRx &&
          rxSincePeak >= stagnationWindows &&
          recent.length >= stagnationWindows
        ) {
          const stagRecent = prescriptionPeaks.slice(-stagnationWindows);
          const meanRecent = stagRecent.reduce((a, b) => a + b, 0) / stagRecent.length;
          const stagFloor = stagnationDeclineRatio * sessionMaxTcs;
          if (meanRecent < stagFloor) {
            closeWith('STAGNATION',
              `no further gains — diminishing returns (Rx_since_peak=${rxSincePeak}, mean_recent_peaks=${meanRecent.toFixed(1)} < floor=${stagFloor.toFixed(1)} [${Math.round(stagnationDeclineRatio * 100)}% of session_max ${sessionMaxTcs.toFixed(1)}])`);
            break;
          }
        }
      }

      // Dispatch
      if (result.appliedSlopeVeto) {
        slopeVetoUsed = true;
        inExtension = true;
        continue;
      }
      if (result.decision === 'HOLD') {
        inExtension = true;
        // Sim-only drift proxy: the real engine's ArousalAnchor.updateDrift() will
        // force a PIVOT after sustained drift on a flat prescription. The sim
        // doesn't model drift, so without a cap a low-gain freq at a mid-range
        // baseline HOLDs forever. Cap HOLDs per prescription at 3 and escalate
        // to PIVOT with the same machinery the state machine would use.
        prescriptionSummary.holdsSoFar = (prescriptionSummary.holdsSoFar || 0) + 1;
        if (prescriptionSummary.holdsSoFar >= 3) {
          metrics.pivotCount++;
          hasPivotedEver = true;
          if (usePrePatchLogic) consecutivePivots++;
          prescriptionSummary.decisions.push({
            t: sessionT, tcsNow: V.tcs.toFixed(1), tcsMax: tcsMaxInState.toFixed(1),
            decision: 'PIVOT', veto: false,
            reason: '[sim drift proxy] HOLD cap reached — arousal anchor would flip'
          });
          if (usePrePatchLogic && consecutivePivots >= pivotBudgetOld) {
            closeWith('PIVOT_BUDGET', `${pivotBudgetOld} consecutive pivots — diminishing returns`);
            break;
          }
          if (!usePrePatchLogic) {
            prescriptionPeaks.push(tcsMaxInState);
            if (tcsMaxInState > sessionMaxTcs) {
              sessionMaxTcs = tcsMaxInState;
              prescriptionOfSessionMax = metrics.prescriptionsPlayed;
            }
            const rxSincePeak = metrics.prescriptionsPlayed - prescriptionOfSessionMax;
            if (
              sessionT >= successMinDur &&
              metrics.prescriptionsPlayed >= stagnationMinRx &&
              rxSincePeak >= stagnationWindows
            ) {
              const stagRecent = prescriptionPeaks.slice(-stagnationWindows);
              const meanRecent = stagRecent.reduce((a, b) => a + b, 0) / stagRecent.length;
              const stagFloor = stagnationDeclineRatio * sessionMaxTcs;
              if (meanRecent < stagFloor) {
                closeWith('STAGNATION',
                  `no further gains — diminishing returns (Rx_since_peak=${rxSincePeak}, mean_recent_peaks=${meanRecent.toFixed(1)} < floor=${stagFloor.toFixed(1)})`);
                break;
              }
            }
          }
          lastHint = 'PIVOT';
          break;
        }
        continue;
      }
      lastHint = result.decision;
      break;
    }

    metrics.timeline.push(prescriptionSummary);
    if (closed) break prescriptionLoop;
  }

  if (!closed) {
    closeWith('TIME_CAP', usePrePatchLogic ? 'Time cap reached' : 'Time cap reached (safety net)');
  }
  metrics.sessionDurationSec = sessionT;
  metrics.sessionMaxTcs = sessionMaxTcs;
  return metrics;
}

// ---------- Reporting ----------
function fmtMin(sec) { return `${(sec / 60).toFixed(1)} min (${sec}s)`; }

function printSummary(m) {
  console.log(`  [${m.label}]`);
  console.log(`    baseline TCS μ=${m.baselineTcsMean}, σ=${m.baselineTcsStd}, significant peak threshold=${m.significantPeak}`);
  console.log(`    session duration    : ${fmtMin(m.sessionDurationSec)}`);
  console.log(`    session max TCS     : ${m.sessionMaxTcs.toFixed(1)}`);
  console.log(`    prescriptions played: ${m.prescriptionsPlayed}`);
  console.log(`    pivots fired        : ${m.pivotCount}`);
  console.log(`    slope-vetoes fired  : ${m.slopeVetoCount}`);
  console.log(`    advances / holds    : ${m.advanceCount} / ${m.holdCount}`);
  console.log(`    closing rule        : ${m.closingRule}`);
  console.log(`    closing reason      : ${m.closingReason}`);
}

function printSustainChecks(m) {
  if (!m.sustainChecks || m.sustainChecks.length === 0) return;
  console.log('    SUSTAINED_PEAK check per prescription end:');
  for (const c of m.sustainChecks) {
    const peaks = c.recentPeaks.map(p => p.toFixed(1)).join(', ');
    const floor = c.floor.toFixed(1);
    const mark = c.passed ? '✓' : '✗';
    console.log(`      Rx#${c.rx} t=${c.t}s  sessionMax=${c.sessionMax.toFixed(1)}  trailingMax=${c.trailingMax.toFixed(1)}  floor=${floor}  recentPeaks=[${peaks}]  ${mark} ${c.gatedBy}`);
  }
}

function printTimeline(m, maxRows = 12) {
  console.log(`    timeline (first ${maxRows} prescriptions):`);
  for (const p of m.timeline.slice(0, maxRows)) {
    const last = p.decisions.at(-1);
    const vetoCount = p.decisions.filter(d => d.veto).length;
    const vetoTag = vetoCount > 0 ? ` [veto×${vetoCount}]` : '';
    console.log(`      ${p.freq} Hz (${p.regime}, ${p.shape}) -> ${last.decision}${vetoTag}  tcsNow=${last.tcsNow} peak=${last.tcsMax}`);
  }
  if (m.timeline.length > maxRows) console.log(`      ... (${m.timeline.length - maxRows} more)`);
}

// ---------- Profiles ----------
const profiles = [
  {
    name: 'PROFILE A — low-baseline noisy (Joe solo)',
    seed: 1001,
    baselineMean: 40, baselineStd: 8, baselineMin: 22, baselineMax: 58
  },
  {
    name: 'PROFILE B — high-baseline with HEAD response (Alisha)',
    seed: 2002,
    baselineMean: 62, baselineStd: 6, baselineMin: 50, baselineMax: 72,
    specialHeadRising: true
  },
  {
    name: 'PROFILE C — music-assisted (Joe + music)',
    seed: 3003,
    baselineMean: 55, baselineStd: 9, baselineMin: 30, baselineMax: 69,
    specialGutRiseDip: true
  }
];

console.log('='.repeat(72));
console.log('PRESCRIPTION ENGINE CALIBRATION SIMULATION');
console.log('='.repeat(72));
console.log(`ENTRAIN window (base/ext): ${config.entrain_min_duration_sec}s / ${config.entrain_extended_min_duration_sec}s`);
console.log(`peak significance K: ${config.peak_significance_k}  (threshold = μ + K·σ)`);
console.log(`slope-veto threshold: +${config.slope_veto_threshold} TCS across window (mean last 5 − mean first 5)`);
console.log(`CLOSE_ON_SUSTAINED_PEAK: t≥${config.success_min_duration_sec}s, last ${config.sustain_windows} peaks ≥ ${Math.round(config.sustain_ratio * 100)}% of trailing_max (max of last ${config.trailing_max_windows} peaks)`);
console.log(`CLOSE_ON_STAGNATION: t≥${config.success_min_duration_sec}s, ≥${config.stagnation_min_prescriptions} Rx, no session_max update in ${config.stagnation_windows} windows, mean recent peaks < ${Math.round(config.stagnation_decline_ratio * 100)}% of session_max`);
console.log(`time cap (new/old): ${config.session_max_duration_sec}s / 1800s (safety net)`);
console.log();

for (const p of profiles) {
  console.log('─'.repeat(72));
  console.log(p.name);
  console.log('─'.repeat(72));
  const before = runSimulation(p, 'BEFORE (pre-patch)', { usePrePatchLogic: true });
  const after = runSimulation(p, 'AFTER  (new calibration)', { usePrePatchLogic: false });
  printSummary(before);
  printSummary(after);
  console.log();
  printTimeline(after);
  console.log();
  printSustainChecks(after);
  console.log();
}
