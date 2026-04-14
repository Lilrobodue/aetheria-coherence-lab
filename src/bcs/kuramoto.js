// bcs/kuramoto.js
// Kuramoto Order Parameter from Doc 5 §3.1.
//
// From Yoshiki Kuramoto's coupled oscillator theory — the canonical
// measurement of "how much does this collection of oscillating things
// behave as one thing."
//
// R(t) = | (1/N) × Σᵢ exp(i × φᵢ(t)) |
//
// Where N = 3 (gut, heart, head regime envelopes).
// R ranges from 0 (random phases) to 1 (perfect phase lock).

import { instantaneousPhase } from '../math/hilbert.js';

/**
 * Compute the Kuramoto order parameter across regime phase series.
 *
 * @param {Float64Array[]} phaseSeriesArray - array of phase time series
 *   [gutPhases, heartPhases, headPhases], each from Hilbert transform
 * @returns {number} mean Kuramoto R over the window (0-1)
 */
export function kuramotoOrderParameter(phaseSeriesArray) {
  const N = phaseSeriesArray.length;
  if (N < 2) return 0;

  // Find minimum length across all series
  const len = Math.min(...phaseSeriesArray.map(p => p.length));
  if (len < 4) return 0;

  // Compute R(t) at each time point, then take the mean
  let sumR = 0;
  for (let t = 0; t < len; t++) {
    let realSum = 0, imagSum = 0;
    for (let i = 0; i < N; i++) {
      realSum += Math.cos(phaseSeriesArray[i][t]);
      imagSum += Math.sin(phaseSeriesArray[i][t]);
    }
    realSum /= N;
    imagSum /= N;
    const R = Math.sqrt(realSum * realSum + imagSum * imagSum);
    sumR += R;
  }

  return sumR / len;
}

/**
 * Compute Kuramoto R from raw regime envelope signals.
 * Extracts instantaneous phase via Hilbert transform, then computes R.
 *
 * @param {Float64Array|number[]} gutEnvelope
 * @param {Float64Array|number[]} heartEnvelope
 * @param {Float64Array|number[]} headEnvelope
 * @returns {number} Kuramoto R (0-1)
 */
export function kuramotoFromEnvelopes(gutEnvelope, heartEnvelope, headEnvelope) {
  const envelopes = [gutEnvelope, heartEnvelope, headEnvelope]
    .filter(e => e && e.length >= 16);

  if (envelopes.length < 2) return 0;

  const phases = envelopes.map(e => instantaneousPhase(e));
  return kuramotoOrderParameter(phases);
}
