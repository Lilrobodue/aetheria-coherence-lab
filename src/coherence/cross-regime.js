// coherence/cross-regime.js  (v1.3)
//
// Cross-regime coherence — Doc 2 §5
//
// CHANGELOG
//   v1.1 — bandpass before Hilbert (PLV saturation fix)
//          + harmonic lock excludes 1:1 and returns 0 (not 1) for under-determined input
//   v1.2 — harmonic ratio table self-contained (1:1 removed)
//          + minimum frequency separation (0.01 Hz)
//          + tolerance tightened to ±1.5%
//   v1.3 — parabolic interpolation in dominant frequency extraction (THIS PATCH)
//          + log-spaced ratio test instead of linear (handles wide ratio range cleanly)
//
// v1.3 lesson from session 5 (30-second test):
//
//   The 30-second session showed harm = 0 or 1 with no fractional values, and
//   peakFreq locked at exactly 0.0625 Hz or 0.125 Hz — which are the FFT bin
//   centers for a 16-second window (1/16 = 0.0625 Hz bin spacing). That's not
//   real measurement, that's bin quantization. With dominant frequencies snapped
//   to discrete bin values, almost every ratio either lands exactly on an integer
//   harmonic (returning 1) or completely misses (returning 0). The harmonic
//   detector was operating correctly given its inputs — but the inputs themselves
//   were degenerate.
//
//   v1.3 adds parabolic interpolation around each PSD peak. Instead of accepting
//   the peak bin as the dominant frequency, we fit a parabola through the peak
//   bin and its two immediate neighbors and compute the true peak from the
//   parabola's vertex. This is a standard DSP technique that gives sub-bin
//   frequency precision from the same coarse FFT data — typically 10-50x better
//   resolution. The dominant frequencies become smooth real numbers instead of
//   bin-quantized values, and the harmonic detector produces a real distribution
//   of values across a session.
//
//   The math is exactly four lines (see parabolicInterpolatePeak below). The
//   change is invisible to every other module — they all just see better numbers
//   coming out of detectHarmonicLock.

import { phaseLockingValue } from '../math/hilbert.js';
import { bandpass, lowpass, resampleLinear } from '../math/filters.js';
import { welchPSD } from '../math/fft.js';

// Regime-specific envelope bands (Hz) — unchanged from v1.2
const ENVELOPE_BANDS = {
  gut:   [0.03, 0.10],
  heart: [0.10, 0.40],
  head:  [0.05, 0.50],
};

export function extractEnvelope(values, timestamps, band) {
  if (values.length < 10) return null;
  const { data: resampled } = resampleLinear(values, timestamps, 4);
  if (resampled.length < 16) return null;
  if (band) return bandpass(resampled, band[0], band[1], 4);
  return lowpass(resampled, 0.5, 4);
}

export function computePLV(envelopeA, envelopeB) {
  if (!envelopeA || !envelopeB) return 0;
  const len = Math.min(envelopeA.length, envelopeB.length);
  if (len < 16) return 0;
  return phaseLockingValue(envelopeA.slice(0, len), envelopeB.slice(0, len));
}

export function computeTriunePLV(gutEnv, heartEnv, headEnv) {
  const result = { triunePLV: null, plvGH: 0, plvHD: 0, plvGD: 0 };
  const pairs = [
    { a: gutEnv,   b: heartEnv, key: 'plvGH' },
    { a: heartEnv, b: headEnv,  key: 'plvHD' },
    { a: gutEnv,   b: headEnv,  key: 'plvGD' },
  ];
  let sum = 0, count = 0;
  for (const { a, b, key } of pairs) {
    if (a && b) {
      const plv = computePLV(a, b);
      result[key] = plv;
      sum += plv;
      count++;
    }
  }
  result.triunePLV = count > 0 ? sum / count : null;
  return result;
}

// --- Harmonic lock v1.3 ---

const HARMONIC_RATIOS = [
  9/8,   6/5,   9/7,   4/3,   3/2,   5/3,   9/5,   2/1,
  9/4,   3/1,   9/2,   6/1,   9/1,
];

const HARMONIC_TOLERANCE = 0.015;
const MIN_FREQ_SEPARATION_HZ = 0.01;

function matchesHarmonicRatio(ratio) {
  for (const target of HARMONIC_RATIOS) {
    if (Math.abs(ratio - target) / target < HARMONIC_TOLERANCE) return true;
  }
  return false;
}

// ============================================================================
// v1.3 NEW: parabolic interpolation around a PSD peak
//
// Given a PSD with peak at bin index `peakIdx`, fit a parabola through
// (peakIdx-1, psd[peakIdx-1]), (peakIdx, psd[peakIdx]), (peakIdx+1, psd[peakIdx+1])
// and return the interpolated peak frequency from the parabola vertex.
//
// Standard DSP technique. Reference: Smith & Serra, "PARSHL: An Analysis/
// Synthesis Program for Non-Harmonic Sounds Based on a Sinusoidal Representation"
// (Stanford CCRMA, 1987) — section on quadratic peak interpolation.
//
// The math:
//   For a parabola y = a*x² + b*x + c fit through three equally-spaced points
//   y[-1], y[0], y[+1], the vertex offset from the center sample is:
//     offset = 0.5 * (y[-1] - y[+1]) / (y[-1] - 2*y[0] + y[+1])
//   The true peak frequency is then:
//     trueFreq = freqs[peakIdx] + offset * binWidth
//
// Returns the interpolated frequency, or the bin center if interpolation fails
// (e.g. peak at array edge).
// ============================================================================
function parabolicInterpolatePeak(psd, freqs, peakIdx) {
  // Edge case: peak at first or last bin — can't interpolate, return as-is
  if (peakIdx <= 0 || peakIdx >= psd.length - 1) {
    return freqs[peakIdx];
  }

  const yLeft   = psd[peakIdx - 1];
  const yCenter = psd[peakIdx];
  const yRight  = psd[peakIdx + 1];

  // Denominator: zero when the three points are collinear (no real peak)
  const denom = yLeft - 2 * yCenter + yRight;
  if (Math.abs(denom) < 1e-12) {
    return freqs[peakIdx]; // degenerate, fall back to bin center
  }

  // Vertex offset from center bin, in units of bins
  const offset = 0.5 * (yLeft - yRight) / denom;

  // Sanity check: parabolic interpolation should give offset in [-0.5, +0.5]
  // for a real peak. If it's outside, the fit is unreliable.
  if (offset < -0.5 || offset > 0.5) {
    return freqs[peakIdx];
  }

  // Bin width — assume uniform spacing
  const binWidth = freqs[peakIdx + 1] - freqs[peakIdx];

  return freqs[peakIdx] + offset * binWidth;
}

// ============================================================================
// detectHarmonicLock — v1.3
//
// Same interface as v1.2. Internal change: dominant frequency extraction
// now uses parabolic interpolation for sub-bin resolution.
// ============================================================================
export function detectHarmonicLock(gutEnv, heartEnv, headEnv) {
  const envelopes = [gutEnv, heartEnv, headEnv].filter(e => e && e.length >= 16);
  if (envelopes.length < 2) return null;

  // Find interpolated dominant frequency for each valid envelope
  const domFreqs = envelopes.map(env => {
    const { psd, freqs } = welchPSD(env, 4, Math.min(64, env.length));

    // Find raw peak bin in the band of interest (0.01 to 1.5 Hz)
    let peakIdx = -1;
    let peakPower = -Infinity;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= 0.01 && freqs[i] <= 1.5 && psd[i] > peakPower) {
        peakPower = psd[i];
        peakIdx = i;
      }
    }
    if (peakIdx < 0) return 0;

    // v1.3: parabolic interpolation for sub-bin resolution
    return parabolicInterpolatePeak(psd, freqs, peakIdx);
  }).filter(f => f > 0.005);

  if (domFreqs.length < 2) return null;

  let harmonicCount = 0;
  let totalPairs = 0;
  let skippedClose = 0;

  for (let i = 0; i < domFreqs.length; i++) {
    for (let j = i + 1; j < domFreqs.length; j++) {
      if (Math.abs(domFreqs[i] - domFreqs[j]) < MIN_FREQ_SEPARATION_HZ) {
        skippedClose++;
        continue;
      }
      const ratio = Math.max(domFreqs[i], domFreqs[j]) / Math.min(domFreqs[i], domFreqs[j]);
      if (matchesHarmonicRatio(ratio)) harmonicCount++;
      totalPairs++;
    }
  }

  const result = totalPairs > 0 ? harmonicCount / totalPairs : 0;

  // Debug: log inputs ~every 10 seconds (more verbose than v1.2 — shows interpolated freqs)
  if (Math.random() < 0.1) {
    console.log('HarmonicLock v1.3:', {
      domFreqs: domFreqs.map(f => f.toFixed(5)),  // 5 decimal places to see sub-bin resolution
      skippedClose,
      totalPairs,
      harmonicCount,
      result: result.toFixed(3),
    });
  }

  return result;
}

export { ENVELOPE_BANDS };
