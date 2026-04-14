// features/heart-features.js
// HEART regime features from Doc 2 §2.
// Computes from R-R intervals: time-domain HRV, frequency-domain HRV,
// and HeartMath-style HRV coherence.

import { welchPSD, bandPower, peakInBand } from '../math/fft.js';
import { resampleLinear } from '../math/filters.js';
import { mean, std, rmssd, pnn50 } from '../math/stats.js';

/**
 * Compute all HEART regime features from R-R interval data.
 *
 * @param {number[]} rrIntervals - R-R intervals in milliseconds
 * @param {number[]} rrTimestamps - timestamps in seconds
 * @returns {object|null} features, or null if insufficient data
 */
export function computeHeartFeatures(rrIntervals, rrTimestamps) {
  if (rrIntervals.length < 10) return null;

  // --- Time-domain HRV ---
  const RMSSD = rmssd(rrIntervals);
  const pNN50 = pnn50(rrIntervals);
  const SDNN = std(rrIntervals);
  const meanRR = mean(rrIntervals);
  const meanHR = meanRR > 0 ? 60000 / meanRR : 0;

  // --- Frequency-domain HRV ---
  // Resample R-R to 4 Hz uniform grid with cubic spline (linear for now)
  const { data: rrResampled } = resampleLinear(rrIntervals, rrTimestamps, 4);

  let vlf = 0, lf = 0, hf = 0, lfHfRatio = 0, hfNorm = 0;
  let hrvCoherence = 0, peakFreq = 0;

  if (rrResampled.length >= 16) {
    // Remove mean (detrend)
    const m = mean(rrResampled);
    const detrended = new Float64Array(rrResampled.length);
    for (let i = 0; i < rrResampled.length; i++) detrended[i] = rrResampled[i] - m;

    // Welch PSD at 4 Hz
    const { psd, freqs } = welchPSD(detrended, 4, Math.min(64, detrended.length));

    // Band powers (Doc 2 §2.2)
    vlf = bandPower(psd, freqs, 0.003, 0.04);
    lf  = bandPower(psd, freqs, 0.04, 0.15);
    hf  = bandPower(psd, freqs, 0.15, 0.40);

    lfHfRatio = hf > 0 ? lf / hf : 0;
    hfNorm = (lf + hf) > 0 ? hf / (lf + hf) : 0;

    // --- HeartMath-style HRV coherence (Doc 2 §2.3) ---
    // PSD of R-R over 0.04–0.26 Hz
    const { peakFreq: pf, peakPower: pp } = peakInBand(psd, freqs, 0.04, 0.26);
    peakFreq = pf;

    // Integrate peak power in ±0.015 Hz window around peak
    const peakBandPower = bandPower(psd, freqs, pf - 0.015, pf + 0.015);
    const totalBandPower = bandPower(psd, freqs, 0.04, 0.26);

    if (totalBandPower > 0 && (totalBandPower - peakBandPower) > 0) {
      hrvCoherence = (peakBandPower * peakBandPower) /
        (totalBandPower * (totalBandPower - peakBandPower));
    }
  }

  return {
    rmssd: RMSSD,
    pnn50: pNN50,
    sdnn: SDNN,
    meanHR,
    meanRR,
    vlf, lf, hf,
    lfHfRatio,
    hfNorm,
    hrvCoherence,
    peakFreq
  };
}
