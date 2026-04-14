// bcs/mutual-information.js
// Normalized Mutual Information from Doc 5 §3.3.
//
// Measures how much knowing one regime's state reduces uncertainty
// about the others, capturing both linear and nonlinear relationships.
//
// nMI(X, Y) = MI(X, Y) / H(X, Y)
// where MI = ΣΣ p(x,y) × log(p(x,y) / (p(x) × p(y)))
//       H  = -ΣΣ p(x,y) × log(p(x,y))

/**
 * Compute normalized mutual information between two signals.
 * Uses histogram-based estimator with Freedman-Diaconis bin width.
 *
 * @param {Float64Array|number[]} x
 * @param {Float64Array|number[]} y
 * @returns {number} nMI (0-1)
 */
export function normalizedMutualInformation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  // Determine bin count using Freedman-Diaconis rule
  const nBins = Math.max(3, Math.min(30, freedmanDiaconisBins(x, n)));

  // Build 2D histogram
  const xMin = min(x, n), xMax = max(x, n);
  const yMin = min(y, n), yMax = max(y, n);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const hist2d = new Float64Array(nBins * nBins);
  const histX = new Float64Array(nBins);
  const histY = new Float64Array(nBins);

  for (let i = 0; i < n; i++) {
    const bx = Math.min(nBins - 1, Math.floor((x[i] - xMin) / xRange * nBins));
    const by = Math.min(nBins - 1, Math.floor((y[i] - yMin) / yRange * nBins));
    hist2d[bx * nBins + by]++;
    histX[bx]++;
    histY[by]++;
  }

  // Normalize to probabilities
  for (let i = 0; i < nBins * nBins; i++) hist2d[i] /= n;
  for (let i = 0; i < nBins; i++) { histX[i] /= n; histY[i] /= n; }

  // Compute MI and joint entropy H(X,Y)
  let mi = 0;
  let hxy = 0;

  for (let i = 0; i < nBins; i++) {
    for (let j = 0; j < nBins; j++) {
      const pxy = hist2d[i * nBins + j];
      if (pxy > 1e-10) {
        const px = histX[i];
        const py = histY[j];
        if (px > 1e-10 && py > 1e-10) {
          mi += pxy * Math.log(pxy / (px * py));
        }
        hxy -= pxy * Math.log(pxy);
      }
    }
  }

  // Normalize: nMI = MI / H(X,Y)
  return hxy > 1e-10 ? Math.max(0, Math.min(1, mi / hxy)) : 0;
}

/**
 * Compute mean pairwise nMI across three regime channels.
 *
 * @param {(Float64Array|number[])[]} channels - [gut, heart, head]
 * @returns {number} mean nMI (0-1)
 */
export function meanPairwiseNMI(channels) {
  const valid = channels.filter(c => c && c.length >= 10);
  if (valid.length < 2) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      sum += normalizedMutualInformation(valid[i], valid[j]);
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

// --- Helpers ---

function min(arr, n) {
  let m = Infinity;
  for (let i = 0; i < n; i++) if (arr[i] < m) m = arr[i];
  return m;
}

function max(arr, n) {
  let m = -Infinity;
  for (let i = 0; i < n; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function freedmanDiaconisBins(arr, n) {
  // Sort a copy for IQR
  const sorted = Array.from(arr).slice(0, n).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  if (iqr < 1e-10) return 10;
  const binWidth = 2 * iqr * Math.pow(n, -1 / 3);
  const range = sorted[n - 1] - sorted[0];
  return Math.ceil(range / binWidth);
}
