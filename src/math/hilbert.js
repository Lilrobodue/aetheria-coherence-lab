// math/hilbert.js
// Hilbert transform for instantaneous phase extraction.
// Used for Phase Locking Value (PLV) computation in cross-regime coherence.

import { fftInPlace, ifftInPlace, nextPow2 } from './fft.js';

/**
 * Compute the analytic signal via Hilbert transform.
 * Returns the imaginary part (Hilbert transform of the input).
 *
 * @param {number[]|Float64Array} signal
 * @returns {Float64Array} imaginary part of the analytic signal
 */
export function hilbertTransform(signal) {
  const n = signal.length;
  const N = nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let i = 0; i < n; i++) re[i] = signal[i];

  fftInPlace(re, im);

  // Construct analytic signal in frequency domain:
  // H[0] = 1, H[N/2] = 1, H[1..N/2-1] = 2, H[N/2+1..N-1] = 0
  // This zeroes negative frequencies and doubles positive frequencies.
  const half = N >> 1;
  for (let i = 1; i < half; i++) {
    re[i] *= 2; im[i] *= 2;
  }
  for (let i = half + 1; i < N; i++) {
    re[i] = 0; im[i] = 0;
  }

  ifftInPlace(re, im);

  // Return imaginary part (the Hilbert transform)
  return im.slice(0, n);
}

/**
 * Extract instantaneous phase from a signal using the Hilbert transform.
 * @param {number[]|Float64Array} signal
 * @returns {Float64Array} instantaneous phase in radians (-π to π)
 */
export function instantaneousPhase(signal) {
  const n = signal.length;
  const N = nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let i = 0; i < n; i++) re[i] = signal[i];

  fftInPlace(re, im);

  const half = N >> 1;
  for (let i = 1; i < half; i++) {
    re[i] *= 2; im[i] *= 2;
  }
  for (let i = half + 1; i < N; i++) {
    re[i] = 0; im[i] = 0;
  }

  ifftInPlace(re, im);

  const phase = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    phase[i] = Math.atan2(im[i], re[i]);
  }
  return phase;
}

/**
 * Phase Locking Value between two signals.
 * PLV ranges from 0 (no phase coupling) to 1 (perfect phase lock).
 *
 * @param {number[]|Float64Array} signalA
 * @param {number[]|Float64Array} signalB
 * @returns {number} PLV (0-1)
 */
export function phaseLockingValue(signalA, signalB) {
  const phaseA = instantaneousPhase(signalA);
  const phaseB = instantaneousPhase(signalB);
  const n = Math.min(phaseA.length, phaseB.length);

  let sumCos = 0, sumSin = 0;
  for (let i = 0; i < n; i++) {
    const diff = phaseA[i] - phaseB[i];
    sumCos += Math.cos(diff);
    sumSin += Math.sin(diff);
  }

  return Math.sqrt(sumCos * sumCos + sumSin * sumSin) / n;
}
