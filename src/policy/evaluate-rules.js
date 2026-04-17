// policy/evaluate-rules.js
// EVALUATE decision rules from Doc 3 §4.
// Strict if/else cascade: first match wins.
// Returns 'HOLD' | 'ADVANCE' | 'PIVOT'.

import { linearSlope } from '../math/stats.js';

/**
 * Evaluate the current entrainment and decide what to do next.
 *
 * @param {object} params
 * @param {number[]} params.tcsHistory - TCS values during this ENTRAIN state
 * @param {number} params.tcsNow - current TCS
 * @param {number} params.tcsAtEntry - TCS when ENTRAIN began
 * @param {number} params.tcsMaxInState - peak TCS observed since entering ENTRAIN
 * @param {object} params.coherenceVector - current CoherenceVector
 * @param {object} params.entryVector - CoherenceVector at entry to ENTRAIN
 * @param {number|null} params.baselineTcsMean - mean TCS during BASELINE (null if not calibrated)
 * @param {number|null} params.baselineTcsStd - std TCS during BASELINE (null if not calibrated)
 * @param {object} config - thresholds from policy.json
 * @returns {{ decision: string, reason: string }}
 */
export function evaluate(params, config) {
  const {
    tcsHistory, tcsNow, tcsAtEntry, tcsMaxInState,
    coherenceVector, entryVector,
    baselineTcsMean, baselineTcsStd
  } = params;

  const deltaTCS = tcsNow - tcsAtEntry;
  const slope = linearSlope(tcsHistory.slice(-30)); // last 30 seconds
  const V = coherenceVector;
  const V0 = entryVector;

  // Thresholds from config
  const advanceDelta = config.advance_tcs_delta_threshold || 15;
  const advancePlateau = config.advance_plateau_tcs_threshold || 70;
  const pivotLowPlateau = config.pivot_low_plateau_tcs_threshold || 50;
  const declineThreshold = config.decline_from_peak_threshold || 10;
  const slopeThreshold = config.plateau_slope_threshold || 0.1;
  // Calibrated 2026-04-17 after session analysis: "high peak" becomes relative to this user's baseline (μ + K·σ), falls back to absolute 65 pre-calibration.
  const peakK = config.peak_significance_k ?? 1.5;
  const significantPeak = (baselineTcsMean != null && baselineTcsStd != null)
    ? (baselineTcsMean + peakK * baselineTcsStd)
    : 65;

  // Rule 1 — Strong positive response
  if (deltaTCS >= advanceDelta && slope >= 0) {
    return {
      decision: 'ADVANCE',
      reason: `Strong response: TCS +${deltaTCS.toFixed(1)}, slope positive`
    };
  }

  // Rule 2 — Coherent plateau at high level
  if (tcsNow >= advancePlateau && Math.abs(slope) < slopeThreshold) {
    return {
      decision: 'ADVANCE',
      reason: `High plateau: TCS ${tcsNow.toFixed(0)} with flat slope`
    };
  }

  // Rule 3 — Coherent plateau at low level
  if (tcsNow < pivotLowPlateau && Math.abs(slope) < slopeThreshold && tcsHistory.length >= 30) {
    return {
      decision: 'PIVOT',
      reason: `Low plateau: TCS ${tcsNow.toFixed(0)} not moving, deficit may have shifted`
    };
  }

  // Rule 4 — Decline from peak
  if (tcsNow < (tcsMaxInState - declineThreshold)) {
    if (tcsMaxInState > significantPeak) {
      return {
        decision: 'ADVANCE',
        reason: `Peak was high (${tcsMaxInState.toFixed(0)} > ${significantPeak.toFixed(0)}), declining — advance`
      };
    } else {
      return {
        decision: 'PIVOT',
        reason: `Declining from low peak (${tcsMaxInState.toFixed(0)} ≤ ${significantPeak.toFixed(0)}) — pivot`
      };
    }
  }

  // Rule 5 — Deficit shift
  if (V.deficit !== V0.deficit && V.deficit !== 'NONE') {
    return {
      decision: 'PIVOT',
      reason: `Deficit shifted from ${V0.deficit} to ${V.deficit}`
    };
  }

  // Rule 6 — Default
  return {
    decision: 'HOLD',
    reason: 'Giving frequency more time'
  };
}
