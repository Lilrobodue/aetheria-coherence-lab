// features/respiration.js
// Respiration estimation from PPG signal (BVP).
// Since ECG is not available on Windows, we derive respiration from the
// Muse's PPG stream instead of ECG-derived respiration (EDR).
// The respiratory modulation of the PPG amplitude envelope provides
// a reasonable estimate (±2 breaths/min accuracy per Doc 2 §3.2).

import { bandpass } from '../math/filters.js';
import { welchPSD, peakInBand } from '../math/fft.js';

/**
 * Estimate respiratory rate and RSA amplitude from PPG signal.
 *
 * @param {Float64Array|number[]} ppgSignal - PPG (BVP) samples
 * @param {number} fs - sampling rate of PPG (typically 64 Hz from Muse)
 * @returns {{ breathRate: number, rsaAmplitude: number }|null}
 */
export function estimateRespiration(ppgSignal, fs) {
  if (ppgSignal.length < fs * 10) return null; // need at least 10s

  // Extract respiratory envelope from PPG:
  // 1. Bandpass filter PPG at 0.1–0.5 Hz (respiratory range: 6–30 breaths/min)
  const respBand = bandpass(ppgSignal, 0.1, 0.5, fs);

  // 2. Compute the amplitude envelope (absolute value, then lowpass)
  const envelope = new Float64Array(respBand.length);
  for (let i = 0; i < respBand.length; i++) {
    envelope[i] = Math.abs(respBand[i]);
  }

  // 3. Find dominant frequency in the envelope spectrum
  const { psd, freqs } = welchPSD(envelope, fs, Math.min(512, envelope.length));
  const { peakFreq } = peakInBand(psd, freqs, 0.1, 0.5);

  const breathRate = peakFreq * 60; // breaths per minute

  // 4. RSA amplitude: standard deviation of the respiratory-filtered RR modulation
  // Since we're deriving from PPG, use the std of the respiratory band signal
  let sumSq = 0;
  for (let i = 0; i < respBand.length; i++) sumSq += respBand[i] * respBand[i];
  const rsaAmplitude = Math.sqrt(sumSq / respBand.length);

  return {
    breathRate: breathRate > 4 && breathRate < 40 ? breathRate : 0,
    rsaAmplitude
  };
}

/**
 * Estimate RSA amplitude from R-R intervals and a breathing rate estimate.
 * This is more accurate than PPG-derived when RR data is available.
 *
 * @param {number[]} rrIntervals - R-R intervals in ms
 * @param {number[]} rrTimestamps - timestamps in seconds
 * @returns {number} RSA amplitude (ms)
 */
export function rsaFromRR(rrIntervals, rrTimestamps) {
  if (rrIntervals.length < 10) return 0;

  // Simple peak-trough method: RSA = mean of (local max RR - local min RR)
  // within each respiratory cycle. Approximate by finding successive
  // peaks and troughs in the RR series.
  const peaks = [];
  const troughs = [];

  for (let i = 1; i < rrIntervals.length - 1; i++) {
    if (rrIntervals[i] > rrIntervals[i - 1] && rrIntervals[i] >= rrIntervals[i + 1]) {
      peaks.push(rrIntervals[i]);
    }
    if (rrIntervals[i] < rrIntervals[i - 1] && rrIntervals[i] <= rrIntervals[i + 1]) {
      troughs.push(rrIntervals[i]);
    }
  }

  const nCycles = Math.min(peaks.length, troughs.length);
  if (nCycles < 2) return 0;

  let rsaSum = 0;
  for (let i = 0; i < nCycles; i++) {
    rsaSum += peaks[i] - troughs[i];
  }

  return rsaSum / nCycles;
}
