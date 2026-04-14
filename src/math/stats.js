// math/stats.js
// Statistical utilities: z-score normalization, sigmoid, linear regression,
// and basic descriptive statistics.

/** Mean of an array. */
export function mean(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/** Standard deviation (population). */
export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / arr.length);
}

/** Root mean square. */
export function rms(arr) {
  if (arr.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += arr[i] * arr[i];
  return Math.sqrt(sumSq / arr.length);
}

/** Sigmoid function: maps any real number to (0, 1). */
export function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Z-score normalizer. Stores baseline mean/std, then scores new values.
 */
export class ZScorer {
  constructor() {
    this._mean = 0;
    this._std = 1;
    this._calibrated = false;
  }

  /** Set baseline from an array of values. Filters out NaN/Infinity. */
  calibrate(values) {
    const clean = values.filter(v => isFinite(v));
    if (clean.length < 2) return; // not enough valid data
    this._mean = mean(clean);
    const rawStd = std(clean);
    this._std = Math.max(rawStd, Math.abs(this._mean) * 0.1, 0.01);
    this._calibrated = true;
  }

  /** Z-score a single value against the stored baseline. Returns 0 for NaN inputs. */
  score(value) {
    if (!this._calibrated || !isFinite(value)) return 0;
    const z = (value - this._mean) / this._std;
    return isFinite(z) ? Math.max(-4, Math.min(4, z)) : 0;
  }

  get calibrated() { return this._calibrated; }
  get baselineMean() { return this._mean; }
  get baselineStd() { return this._std; }
}

/**
 * Linear regression slope (y vs x index).
 * @param {number[]|Float64Array} values
 * @returns {number} slope (units per sample)
 */
export function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Root Mean Square of Successive Differences (RMSSD).
 * Primary time-domain HRV metric for vagal tone.
 */
export function rmssd(rrIntervals) {
  if (rrIntervals.length < 2) return 0;
  let sumSqDiff = 0;
  let count = 0;
  for (let i = 1; i < rrIntervals.length; i++) {
    const diff = rrIntervals[i] - rrIntervals[i - 1];
    sumSqDiff += diff * diff;
    count++;
  }
  return Math.sqrt(sumSqDiff / count);
}

/**
 * pNN50: percentage of successive RR intervals differing by > 50ms.
 */
export function pnn50(rrIntervals) {
  if (rrIntervals.length < 2) return 0;
  let count50 = 0;
  for (let i = 1; i < rrIntervals.length; i++) {
    if (Math.abs(rrIntervals[i] - rrIntervals[i - 1]) > 50) count50++;
  }
  return (count50 / (rrIntervals.length - 1)) * 100;
}

/**
 * SD1 from Poincaré plot: short-axis standard deviation.
 * SD1 = RMSSD / sqrt(2) — measures beat-to-beat vagal modulation.
 */
export function sd1(rrIntervals) {
  return rmssd(rrIntervals) / Math.SQRT2;
}

/**
 * Pearson correlation coefficient.
 */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom < 1e-10 ? 0 : cov / denom;
}
