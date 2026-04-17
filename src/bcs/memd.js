// bcs/memd.js
// Multivariate Empirical Mode Decomposition (MEMD) from Doc 5 §3.2.
// Based on Rehman & Mandic 2010.
//
// This is the heart of BCS — tests whether one underlying pattern
// explains all three regimes (generative unity).
//
// MEMD finds oscillatory modes (IMFs) that exist ACROSS all channels
// simultaneously. If three signals share many modes, they're expressions
// of overlapping underlying processes.

/**
 * Run Multivariate EMD on a multi-channel signal.
 * Simplified implementation: uses projection-based envelope estimation
 * with uniform direction sampling on the unit sphere.
 *
 * @param {(Float64Array|number[])[]} channels - [gut, heart, head] signals
 * @param {object} [options]
 * @param {number} [options.maxIMFs=5] - maximum number of IMFs to extract
 * @param {number} [options.maxSifts=20] - max sifting iterations per IMF
 * @param {number} [options.nDirections=16] - number of projection directions
 * @param {number} [options.siftThreshold=0.1] - convergence threshold
 * @returns {object[]} array of IMFs, each { channels: Float64Array[] }
 */
export function multivariateEMD(channels, options = {}) {
  const maxIMFs = options.maxIMFs || 5;
  const maxSifts = options.maxSifts || 20;
  const nDirs = options.nDirections || 16;
  const threshold = options.siftThreshold || 0.1;

  const nCh = channels.length;
  const len = Math.min(...channels.map(c => c.length));
  if (len < 16 || nCh < 2) return [];

  // Generate uniform directions on the unit sphere
  const directions = generateDirections(nCh, nDirs);

  // Working residual (copy of input)
  const residual = channels.map(c => Float64Array.from(c.slice(0, len)));
  const imfs = [];

  for (let imfIdx = 0; imfIdx < maxIMFs; imfIdx++) {
    // Check if residual has enough energy to extract another IMF
    const energy = residual.reduce((s, ch) =>
      s + ch.reduce((ss, v) => ss + v * v, 0), 0);
    if (energy < 1e-10 * len * nCh) break;

    // Sifting process
    let mode = residual.map(ch => Float64Array.from(ch));

    for (let sift = 0; sift < maxSifts; sift++) {
      // Compute multivariate mean envelope
      const meanEnv = computeMeanEnvelope(mode, directions, len, nCh);

      // Subtract mean envelope
      let diff = 0;
      for (let c = 0; c < nCh; c++) {
        for (let i = 0; i < len; i++) {
          const prev = mode[c][i];
          mode[c][i] -= meanEnv[c][i];
          diff += (mode[c][i] - prev) * (mode[c][i] - prev);
        }
      }

      // Check convergence
      const modeEnergy = mode.reduce((s, ch) =>
        s + ch.reduce((ss, v) => ss + v * v, 0), 0);
      if (modeEnergy > 0 && diff / modeEnergy < threshold) break;
    }

    imfs.push({ channels: mode });

    // Subtract IMF from residual
    for (let c = 0; c < nCh; c++) {
      for (let i = 0; i < len; i++) {
        residual[c][i] -= mode[c][i];
      }
    }
  }

  return imfs;
}

/**
 * Compute the shared mode energy fraction (Doc 5 §3.2).
 * An IMF is "shared" if it carries >10% of channel total energy in ALL channels.
 *
 * Returns a {value, quality, reason?} result so downstream consumers can
 * distinguish "no measurement" (null) from "zero coherence measured" (0).
 * Calibrated 2026-04-17 after session analysis exposed exact-0 dropouts
 * clustered at session start/end — those were "no measurement" cases being
 * written as numeric 0, poisoning aggregates and (now) decision paths.
 *
 * @param {(Float64Array|number[])[]} channels
 * @returns {{ value: number|null, quality: string, reason?: string }}
 *   quality ∈ 'ok' | 'low_variance' | 'divide_by_zero' | 'nan_guard'
 *   value is null whenever quality !== 'ok'; 0 is only returned with
 *   quality='ok' and means a legitimate "no shared modes detected" result.
 */
export function sharedModeEnergyFraction(channels) {
  const imfs = multivariateEMD(channels);

  // Path A: MEMD's residual-energy threshold broke the IMF loop before any
  // IMF was extracted. Near-zero input energy — sensor settling, flat
  // signal, or one channel disconnected. Not a real zero measurement.
  if (imfs.length === 0) {
    return { value: null, quality: 'low_variance', reason: 'memd_produced_no_imfs' };
  }

  const nCh = channels.length;

  // Total energy per channel
  const totalEnergy = new Float64Array(nCh);
  for (const imf of imfs) {
    for (let c = 0; c < nCh; c++) {
      for (let i = 0; i < imf.channels[c].length; i++) {
        totalEnergy[c] += imf.channels[c][i] * imf.channels[c][i];
      }
    }
  }

  // Identify shared IMFs (>10% of total energy in ALL channels)
  let sharedEnergy = 0;
  let totalAllEnergy = 0;

  for (const imf of imfs) {
    const imfEnergy = new Float64Array(nCh);
    let imfTotal = 0;
    for (let c = 0; c < nCh; c++) {
      for (let i = 0; i < imf.channels[c].length; i++) {
        imfEnergy[c] += imf.channels[c][i] * imf.channels[c][i];
      }
      imfTotal += imfEnergy[c];
    }
    totalAllEnergy += imfTotal;

    // Check if this IMF is "shared" — significant in ALL channels
    const isShared = imfEnergy.every((e, c) => totalEnergy[c] > 0 && e / totalEnergy[c] > 0.10);
    if (isShared) sharedEnergy += imfTotal;
  }

  // Path B: degenerate — IMFs exist but all carry zero summed energy.
  if (totalAllEnergy <= 0) {
    return { value: null, quality: 'divide_by_zero', reason: 'all_imfs_zero_energy' };
  }

  // Path C: legitimate measurement. value may be 0 if no IMF qualified as
  // "shared" — that's a real "no generative unity" result, not a dropout.
  return { value: sharedEnergy / totalAllEnergy, quality: 'ok' };
}

// --- Internal helpers ---

/** Generate uniformly distributed directions on the N-sphere. */
function generateDirections(nDim, nDirs) {
  const dirs = [];
  for (let d = 0; d < nDirs; d++) {
    const dir = new Float64Array(nDim);
    // Use low-discrepancy sequence for uniform coverage
    const phi = (2 * Math.PI * d) / nDirs;
    if (nDim === 2) {
      dir[0] = Math.cos(phi);
      dir[1] = Math.sin(phi);
    } else if (nDim === 3) {
      const theta = Math.acos(1 - 2 * (d + 0.5) / nDirs);
      const golden = Math.PI * (1 + Math.sqrt(5)); // golden angle
      const azimuth = golden * d;
      dir[0] = Math.sin(theta) * Math.cos(azimuth);
      dir[1] = Math.sin(theta) * Math.sin(azimuth);
      dir[2] = Math.cos(theta);
    } else {
      // Fallback: random directions for higher dimensions
      let norm = 0;
      for (let i = 0; i < nDim; i++) {
        dir[i] = Math.random() * 2 - 1;
        norm += dir[i] * dir[i];
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < nDim; i++) dir[i] /= norm;
    }
    dirs.push(dir);
  }
  return dirs;
}

/** Compute the multivariate mean envelope using projection-based method. */
function computeMeanEnvelope(channels, directions, len, nCh) {
  const meanEnv = channels.map(() => new Float64Array(len));
  const nDirs = directions.length;

  for (const dir of directions) {
    // Project multivariate signal onto this direction
    const projection = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        projection[i] += channels[c][i] * dir[c];
      }
    }

    // Find local maxima and minima of the projection
    const maxIdx = [], minIdx = [];
    for (let i = 1; i < len - 1; i++) {
      if (projection[i] > projection[i - 1] && projection[i] >= projection[i + 1]) maxIdx.push(i);
      if (projection[i] < projection[i - 1] && projection[i] <= projection[i + 1]) minIdx.push(i);
    }

    // Interpolate upper and lower envelopes per channel
    for (let c = 0; c < nCh; c++) {
      const upper = interpolateEnvelope(channels[c], maxIdx, len);
      const lower = interpolateEnvelope(channels[c], minIdx, len);
      for (let i = 0; i < len; i++) {
        meanEnv[c][i] += (upper[i] + lower[i]) / 2 / nDirs;
      }
    }
  }

  return meanEnv;
}

/** Linear interpolation of envelope through extrema points. */
function interpolateEnvelope(signal, indices, len) {
  const env = new Float64Array(len);
  if (indices.length < 2) {
    // Not enough extrema — flat envelope at signal mean
    let sum = 0;
    for (let i = 0; i < len; i++) sum += signal[i];
    env.fill(sum / len);
    return env;
  }

  // Linear interpolation between extrema
  for (let i = 0; i < len; i++) {
    // Find bracketing indices
    let lo = 0, hi = indices.length - 1;
    while (lo < hi - 1 && indices[lo + 1] <= i) lo++;
    hi = Math.min(lo + 1, indices.length - 1);

    if (i <= indices[0]) {
      env[i] = signal[indices[0]];
    } else if (i >= indices[indices.length - 1]) {
      env[i] = signal[indices[indices.length - 1]];
    } else {
      const t = (i - indices[lo]) / (indices[hi] - indices[lo]);
      env[i] = signal[indices[lo]] * (1 - t) + signal[indices[hi]] * t;
    }
  }

  return env;
}
