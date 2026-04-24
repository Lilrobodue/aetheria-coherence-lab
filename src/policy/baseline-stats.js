// policy/baseline-stats.js
// Aggregates a baseline window of per-sample coherence + feature data into
// a stats object shaped for the classifier and for session metadata.
//
// Spec reference: coherence_lab_baseline_spec.md §3.1 and §4.1.

import { mean, std } from '../math/stats.js';

const REGIMES = ['GUT', 'HEART', 'HEAD'];
const REGIME_KEYS = { GUT: 'gut', HEART: 'heart', HEAD: 'head' };

function clamp01(x) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Compute spin_strength = clamp01(hrvCoherence/3) * clamp01(rmssd/50) * kuramoto.
 * Undefined inputs are treated as 0 (matches rule-of-absence in the spec).
 */
export function spinStrength({ hrvCoherence, rmssd, kuramoto }) {
  const a = clamp01((hrvCoherence ?? 0) / 3);
  const b = clamp01((rmssd ?? 0) / 50);
  const k = clamp01(kuramoto ?? 0);
  return a * b * k;
}

/**
 * @param {Array<{gut:number|null, heart:number|null, head:number|null, harm:number|null, triunePLV:number|null, deficit?:string}>} coherenceSamples
 * @param {Array<{heart?:{hrvCoherence?:number, rmssd?:number}}>} featureSamples
 * @param {Array<{kuramoto?:number}>} bcsSamples
 * @param {Object} [opts]
 * @param {number} [opts.durationSec] Duration of the baseline window in seconds.
 * @param {string} [opts.signalQuality] 'good' | 'fair' | 'poor'
 * @returns {object} baseline stats object (classifier-ready + metadata-ready)
 */
export function summarizeBaseline(coherenceSamples, featureSamples, bcsSamples, opts = {}) {
  const coh = coherenceSamples || [];
  const feats = featureSamples || [];
  const bcs = bcsSamples || [];

  const perRegime = {};
  for (const R of REGIMES) {
    const key = REGIME_KEYS[R];
    const vals = coh.map(s => s && s[key]).filter(v => v != null && isFinite(v));
    perRegime[R] = {
      mean: vals.length ? +mean(vals).toFixed(3) : 0,
      sd:   vals.length >= 2 ? +std(vals).toFixed(3) : 0,
    };
  }

  const harmVals = coh.map(s => s && (s.harm ?? s.harmonicLock)).filter(v => v != null && isFinite(v));
  const harmMean = harmVals.length ? +mean(harmVals).toFixed(3) : 0;
  const harmSd   = harmVals.length >= 2 ? +std(harmVals).toFixed(3) : 0;

  // Deficit majority over the baseline window (targeted-selection spec §3.1, §4.1).
  // Uses per-sample `deficit` field from coherence vectors. We count a regime
  // as the deficit only if it appears as such in at least one sample; NONE is
  // tracked separately for the log. Ties break by lowest baseline mean.
  const deficitVotes = { GUT: 0, HEART: 0, HEAD: 0, NONE: 0 };
  for (const s of coh) {
    const d = s?.deficit;
    if (d && deficitVotes[d] != null) deficitVotes[d]++;
  }
  const regimeVotes = [['GUT', deficitVotes.GUT], ['HEART', deficitVotes.HEART], ['HEAD', deficitVotes.HEAD]];
  const topRegime = regimeVotes.sort((a, b) => b[1] - a[1] || perRegime[a[0]].mean - perRegime[b[0]].mean);
  const deficitMajority = topRegime[0][1] > 0 ? topRegime[0][0] : null;

  const kuramotoVals = bcs.map(s => s && s.kuramoto).filter(v => v != null && isFinite(v));
  const kuramotoMean = kuramotoVals.length ? +mean(kuramotoVals).toFixed(3) : 0;

  // Spin strength series: one value per feature sample, joined to the nearest
  // BCS kuramoto in time. If BCS is sparse, fall back to the most recent one.
  const spinSeries = [];
  let bcsIdx = 0;
  for (const f of feats) {
    const t = f.t ?? f.timestamp ?? 0;
    while (bcsIdx + 1 < bcs.length && (bcs[bcsIdx + 1].t ?? 0) <= t) bcsIdx++;
    const k = bcs[bcsIdx]?.kuramoto ?? 0;
    const h = f.heart?.hrvCoherence;
    const r = f.heart?.rmssd;
    spinSeries.push(spinStrength({ hrvCoherence: h, rmssd: r, kuramoto: k }));
  }
  const spinPeak = spinSeries.length ? Math.max(...spinSeries) : 0;
  const spinMean = spinSeries.length ? mean(spinSeries) : 0;

  const breathRates = feats.map(f => f.resp?.breathRate ?? f.respiration?.breathRate).filter(v => v != null && isFinite(v));
  const hrvPeaks = feats.map(f => f.heart?.hrvPeakHz).filter(v => v != null && isFinite(v));
  const iafs = feats.map(f => f.head?.iaf).filter(v => v != null && isFinite(v));

  const maxSd = Math.max(perRegime.GUT.sd, perRegime.HEART.sd, perRegime.HEAD.sd);
  const signalQuality = opts.signalQuality || (
    coh.length >= 30 && maxSd < 0.25 ? 'good' :
    coh.length >= 15 ? 'fair' : 'poor'
  );

  return {
    duration_s: opts.durationSec ?? null,
    sample_count: coh.length,
    GUT:   perRegime.GUT,
    HEART: perRegime.HEART,
    HEAD:  perRegime.HEAD,
    harm_mean: harmMean,
    harm_sd: harmSd,
    kuramoto_mean: kuramotoMean,
    spin_strength_mean: +spinMean.toFixed(3),
    spin_strength_peak: +spinPeak.toFixed(3),
    breath_rate_mean_bpm: breathRates.length ? +mean(breathRates).toFixed(2) : null,
    hrv_peak_hz: hrvPeaks.length ? +mean(hrvPeaks).toFixed(3) : null,
    iaf_hz: iafs.length ? +mean(iafs).toFixed(2) : null,
    signal_quality: signalQuality,
    deficit_majority: deficitMajority,
    deficit_votes: { ...deficitVotes },
  };
}
