// features/head-features.js
// HEAD regime features from Doc 2 §4.
// EEG band powers, Individual Alpha Frequency (IAF), frontal alpha asymmetry,
// and fNIRS hemodynamic features.

import { welchPSD, bandPower, peakInBand } from '../math/fft.js';
import { mean } from '../math/stats.js';

// EEG band definitions (Doc 2 §4.1)
const BANDS = {
  delta: [1, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta:  [13, 30],
  gamma: [30, 45]
};

/**
 * Compute HEAD regime features from EEG and fNIRS data.
 * Returns null when there is insufficient data — callers should treat null
 * as "HEAD regime offline" and propagate it through the coherence chain.
 *
 * @param {object|null} eegChannels - { TP9: number[], AF7: number[], AF8: number[], TP10: number[] }
 * @param {number} eegFs - EEG sampling rate (256 Hz from Muse)
 * @param {object|null} fnirsData - { hbO: number, hbR: number } latest fNIRS values
 * @param {number|null} iaf - Individual Alpha Frequency (computed once at baseline, or null)
 * @returns {object|null}
 */
export function computeHeadFeatures(eegChannels, eegFs, fnirsData, iaf) {
  if (!eegChannels) return null;

  // Need at least 1 second of EEG data on every channel
  const channels = ['TP9', 'AF7', 'AF8', 'TP10'];
  const minSamples = eegFs; // 1 second
  for (const ch of channels) {
    if (!eegChannels[ch] || eegChannels[ch].length < minSamples) return null;
  }

  // Compute band powers per channel, then average across channels
  const bandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  const perChannel = {};

  for (const ch of channels) {
    const data = eegChannels[ch];
    // Use last 4 seconds (or available data) with 50% overlap (Doc 2 §4.1)
    const segLen = Math.min(4 * eegFs, data.length);
    const segment = data.slice(-segLen);

    // Remove mean
    const m = mean(segment);
    const detrended = new Float64Array(segment.length);
    for (let i = 0; i < segment.length; i++) detrended[i] = segment[i] - m;

    const { psd, freqs } = welchPSD(detrended, eegFs, Math.min(256, segment.length));

    const chPowers = {};
    for (const [band, [lo, hi]] of Object.entries(BANDS)) {
      chPowers[band] = bandPower(psd, freqs, lo, hi);
    }

    perChannel[ch] = { powers: chPowers, psd, freqs };

    for (const band of Object.keys(bandPowers)) {
      bandPowers[band] += chPowers[band];
    }
  }

  // Average across channels
  for (const band of Object.keys(bandPowers)) {
    bandPowers[band] /= channels.length;
  }

  // Total power
  const totalPower = Object.values(bandPowers).reduce((a, b) => a + b, 0);

  // Normalized alpha power (Doc 2 §4.2)
  const alphaPowerNorm = totalPower > 0 ? bandPowers.alpha / totalPower : 0;

  // Theta/Alpha ratio (Doc 2 §4.2)
  const thetaAlphaRatio = bandPowers.alpha > 0 ? bandPowers.theta / bandPowers.alpha : 0;

  // Frontal Alpha Asymmetry (Doc 2 §4.2): log(AF8_alpha) - log(AF7_alpha)
  const af7Alpha = perChannel.AF7?.powers.alpha || 0;
  const af8Alpha = perChannel.AF8?.powers.alpha || 0;
  const frontalAlphaAsymmetry = (af7Alpha > 0 && af8Alpha > 0)
    ? Math.log(af8Alpha) - Math.log(af7Alpha)
    : 0;

  // Individual Alpha Frequency (peak in alpha band, averaged across channels)
  let computedIAF = iaf;
  if (!computedIAF) {
    let iafSum = 0, iafCount = 0;
    for (const ch of channels) {
      const { psd, freqs } = perChannel[ch];
      const { peakFreq } = peakInBand(psd, freqs, 8, 13);
      if (peakFreq > 0) { iafSum += peakFreq; iafCount++; }
    }
    computedIAF = iafCount > 0 ? iafSum / iafCount : 10; // default 10 Hz
  }

  // fNIRS features (Doc 2 §4.3)
  let hbO = 0, hbR = 0, hbT = 0, hbDiff = 0;
  if (fnirsData) {
    hbO = fnirsData.hbO || 0;
    hbR = fnirsData.hbR || 0;
    hbT = hbO + hbR;
    hbDiff = hbO - hbR;
  }

  // Beta power (for negative weighting in HEAD score)
  const betaPower = totalPower > 0 ? bandPowers.beta / totalPower : 0;

  return {
    ...bandPowers,
    totalPower,
    alphaPowerNorm,
    thetaAlphaRatio,
    frontalAlphaAsymmetry,
    iaf: computedIAF,
    betaPower,
    hbO, hbR, hbT, hbDiff
  };
}
