// math/filters.js
// Digital filters: biquad lowpass/highpass/bandpass with zero-phase (filtfilt).
// Used for envelope extraction, HRV preprocessing, and respiration estimation.

/** Biquad lowpass filter coefficients (Butterworth). */
export function biquadLPF(fc, fs) {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Math.SQRT2);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b: [(1 - cosw) / 2 / a0, (1 - cosw) / a0, (1 - cosw) / 2 / a0],
    a: [1, -2 * cosw / a0, (1 - alpha) / a0]
  };
}

/** Biquad highpass filter coefficients (Butterworth). */
export function biquadHPF(fc, fs) {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * Math.SQRT2);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b: [(1 + cosw) / 2 / a0, -(1 + cosw) / a0, (1 + cosw) / 2 / a0],
    a: [1, -2 * cosw / a0, (1 - alpha) / a0]
  };
}

/** Forward IIR filter (causal). */
export function filterForward(b, a, data) {
  const n = data.length;
  const out = new Float64Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    out[i] = b[0] * data[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = data[i];
    y2 = y1; y1 = out[i];
  }
  return out;
}

/** Zero-phase filtering (forward-backward). No phase distortion. */
export function filtfilt(b, a, data) {
  const fwd = filterForward(b, a, data);
  const n = fwd.length;
  const rev = new Float64Array(n);
  for (let i = 0; i < n; i++) rev[i] = fwd[n - 1 - i];
  const bwd = filterForward(b, a, rev);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = bwd[n - 1 - i];
  return out;
}

/** Bandpass filter (zero-phase): highpass then lowpass. */
export function bandpass(data, fLow, fHigh, fs) {
  const hp = biquadHPF(fLow, fs);
  const lp = biquadLPF(fHigh, fs);
  return filtfilt(lp.b, lp.a, filtfilt(hp.b, hp.a, data));
}

/** Lowpass filter (zero-phase). */
export function lowpass(data, fc, fs) {
  const lp = biquadLPF(fc, fs);
  return filtfilt(lp.b, lp.a, data);
}

/** Highpass filter (zero-phase). */
export function highpass(data, fc, fs) {
  const hp = biquadHPF(fc, fs);
  return filtfilt(hp.b, hp.a, data);
}

/**
 * Resample a signal to a new rate using linear interpolation.
 * @param {Float64Array|number[]} data - input samples
 * @param {Float64Array|number[]} timestamps - input timestamps (seconds)
 * @param {number} targetRate - output rate (Hz)
 * @returns {{ data: Float64Array, timestamps: Float64Array }}
 */
export function resampleLinear(data, timestamps, targetRate) {
  if (data.length < 2) return { data: new Float64Array(0), timestamps: new Float64Array(0) };

  const tStart = timestamps[0];
  const tEnd = timestamps[timestamps.length - 1];
  const duration = tEnd - tStart;
  const nOut = Math.floor(duration * targetRate) + 1;
  const outData = new Float64Array(nOut);
  const outTime = new Float64Array(nOut);

  let j = 0;
  for (let i = 0; i < nOut; i++) {
    const t = tStart + i / targetRate;
    outTime[i] = t;

    // Advance j to bracket t
    while (j < timestamps.length - 2 && timestamps[j + 1] < t) j++;

    if (j >= timestamps.length - 1) {
      outData[i] = data[data.length - 1];
    } else {
      const frac = (t - timestamps[j]) / (timestamps[j + 1] - timestamps[j]);
      outData[i] = data[j] + frac * (data[j + 1] - data[j]);
    }
  }

  return { data: outData, timestamps: outTime };
}
