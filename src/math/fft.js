// math/fft.js
// FFT, inverse FFT, and Welch PSD estimation.
// Used for frequency-domain HRV (LF/HF), EEG band powers, and coherence detection.

/**
 * Radix-2 Cooley-Tukey FFT (in-place).
 * @param {Float64Array} re - real part (length must be power of 2)
 * @param {Float64Array} im - imaginary part
 */
export function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cR = 1, cI = 0;
      for (let j = 0; j < half; j++) {
        const k = i + j + half;
        const tR = re[k] * cR - im[k] * cI;
        const tI = re[k] * cI + im[k] * cR;
        re[k] = re[i + j] - tR;
        im[k] = im[i + j] - tI;
        re[i + j] += tR;
        im[i + j] += tI;
        const nR = cR * wR - cI * wI;
        cI = cR * wI + cI * wR;
        cR = nR;
      }
    }
  }
}

/** Inverse FFT (in-place). */
export function ifftInPlace(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

/** Next power of 2 >= n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Compute FFT of a real signal. Returns { re, im, N } where N is the padded length.
 * @param {number[]|Float64Array} signal
 * @returns {{ re: Float64Array, im: Float64Array, N: number }}
 */
export function fft(signal) {
  const N = nextPow2(signal.length);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];
  fftInPlace(re, im);
  return { re, im, N };
}

/**
 * Welch PSD estimate.
 * Splits the signal into overlapping segments, applies a Hann window,
 * computes FFT, and averages the periodograms.
 *
 * @param {number[]|Float64Array} signal - input signal
 * @param {number} fs - sampling rate (Hz)
 * @param {number} [segmentLength] - segment length in samples (default: 256 or signal.length)
 * @param {number} [overlap=0.5] - overlap fraction
 * @returns {{ psd: Float64Array, freqs: Float64Array }}
 */
export function welchPSD(signal, fs, segmentLength, overlap = 0.5) {
  const n = signal.length;
  const segLen = segmentLength || Math.min(256, nextPow2(n));
  const nfft = nextPow2(segLen);
  const step = Math.max(1, Math.floor(segLen * (1 - overlap)));
  const nBins = (nfft >> 1) + 1;

  // Hann window
  const win = new Float64Array(segLen);
  let winPower = 0;
  for (let i = 0; i < segLen; i++) {
    win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (segLen - 1)));
    winPower += win[i] * win[i];
  }

  const psd = new Float64Array(nBins);
  let numSegments = 0;

  for (let start = 0; start + segLen <= n; start += step) {
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < segLen; i++) {
      re[i] = signal[start + i] * win[i];
    }
    fftInPlace(re, im);

    for (let i = 0; i < nBins; i++) {
      psd[i] += (re[i] * re[i] + im[i] * im[i]);
    }
    numSegments++;
  }

  // If signal too short for any segment, do a single windowed FFT
  if (numSegments === 0) {
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) {
      re[i] = signal[i] * (i < segLen ? win[i] : 0.5);
    }
    fftInPlace(re, im);
    for (let i = 0; i < nBins; i++) {
      psd[i] = re[i] * re[i] + im[i] * im[i];
    }
    numSegments = 1;
  }

  // Normalize: average and scale by window power and sampling rate
  const scale = 1 / (numSegments * winPower * fs);
  for (let i = 0; i < nBins; i++) {
    psd[i] *= scale;
    if (i > 0 && i < nBins - 1) psd[i] *= 2; // single-sided
  }

  const freqs = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    freqs[i] = i * fs / nfft;
  }

  return { psd, freqs };
}

/**
 * Integrate PSD over a frequency band.
 * @param {Float64Array} psd
 * @param {Float64Array} freqs
 * @param {number} fLow
 * @param {number} fHigh
 * @returns {number} band power
 */
export function bandPower(psd, freqs, fLow, fHigh) {
  let power = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= fLow && freqs[i] < fHigh) {
      power += psd[i];
    }
  }
  // Multiply by frequency resolution for proper integration
  const df = freqs.length > 1 ? freqs[1] - freqs[0] : 1;
  return power * df;
}

/**
 * Find peak frequency and power in a band.
 * @returns {{ peakFreq: number, peakPower: number }}
 */
export function peakInBand(psd, freqs, fLow, fHigh) {
  let maxPower = -Infinity;
  let peakFreq = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= fLow && freqs[i] < fHigh && psd[i] > maxPower) {
      maxPower = psd[i];
      peakFreq = freqs[i];
    }
  }
  return { peakFreq, peakPower: maxPower };
}
