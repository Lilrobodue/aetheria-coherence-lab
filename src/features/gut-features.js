// features/gut-features.js
// GUT regime features from Doc 2 §3.
// The GUT regime is read through the vagus via HF-HRV, not directly from the abdomen.
// These features come from the same H10 R-R data as HEART, but focus on vagal markers.

import { sd1 } from '../math/stats.js';
import { rsaFromRR } from './respiration.js';

/**
 * Compute GUT regime features.
 * Requires heart features (for HF power) and R-R data (for SD1, RSA).
 *
 * @param {object} heartFeatures - output from computeHeartFeatures()
 * @param {number[]} rrIntervals - R-R intervals in ms
 * @param {number[]} rrTimestamps - timestamps in seconds
 * @returns {object|null}
 */
export function computeGutFeatures(heartFeatures, rrIntervals, rrTimestamps) {
  if (!heartFeatures || rrIntervals.length < 5) return null;

  const hfPower = heartFeatures.hf;
  const SD1 = sd1(rrIntervals);
  const rsaAmplitude = rsaFromRR(rrIntervals, rrTimestamps);

  return {
    hfPower,
    sd1: SD1,
    rsaAmplitude
  };
}
