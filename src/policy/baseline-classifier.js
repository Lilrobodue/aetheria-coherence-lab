// policy/baseline-classifier.js
// Pure classifier: maps baseline stats -> arrival-state label.
// No side effects, no dependencies on the engine. Safe to unit-test in isolation.
//
// Spec reference: coherence_lab_baseline_spec.md §3.2.

/**
 * @typedef {Object} RegimeStats
 * @property {number} mean  Baseline mean coherence [0..1]
 * @property {number} sd    Baseline standard deviation [0..1]
 */

/**
 * @typedef {Object} BaselineInput
 * @property {RegimeStats} GUT
 * @property {RegimeStats} HEART
 * @property {RegimeStats} HEAD
 * @property {number} [spin_strength_peak]  Peak spin_strength during the baseline window.
 * @property {number} [sample_count]        Number of coherence samples aggregated.
 */

/**
 * @typedef {Object} ClassifierConfig
 * @property {number} [unstable_sd_max]       SD threshold above which the window is "unstable". Default 0.20.
 * @property {number} [regulated_mean_min]    Per-regime mean floor for "regulated". Default 0.70.
 * @property {number} [regulated_sd_max]      Per-regime SD ceiling for "regulated". Default 0.10.
 * @property {number} [dysregulated_mean_max] Per-regime mean ceiling for "dysregulated". Default 0.50.
 * @property {number} [spin_active_threshold} Spin peak above which "regulated" becomes "regulated_active". Default 0.30.
 */

export const DEFAULT_CLASSIFIER_CONFIG = Object.freeze({
  unstable_sd_max: 0.20,
  regulated_mean_min: 0.70,
  regulated_sd_max: 0.10,
  dysregulated_mean_max: 0.50,
  spin_active_threshold: 0.30,
});

export const CLASSIFICATIONS = Object.freeze({
  REGULATED_ACTIVE: 'regulated_active',
  REGULATED_STABLE: 'regulated_stable',
  MIXED: 'mixed',
  DYSREGULATED: 'dysregulated',
  UNSTABLE: 'unstable',
});

const REGIMES = ['GUT', 'HEART', 'HEAD'];

/**
 * Classify an arriving user from baseline stats.
 * @param {BaselineInput} baseline
 * @param {ClassifierConfig} [config]
 * @returns {'regulated_active'|'regulated_stable'|'mixed'|'dysregulated'|'unstable'}
 */
export function classify(baseline, config) {
  const cfg = { ...DEFAULT_CLASSIFIER_CONFIG, ...(config || {}) };

  if (!baseline) return CLASSIFICATIONS.UNSTABLE;
  for (const r of REGIMES) {
    const s = baseline[r];
    if (!s || !isFinite(s.mean) || !isFinite(s.sd)) return CLASSIFICATIONS.UNSTABLE;
  }

  const means = REGIMES.map(r => baseline[r].mean);
  const sds   = REGIMES.map(r => baseline[r].sd);
  const noisyRegimes = sds.filter(s => s > cfg.unstable_sd_max).length;
  const spinPeak = baseline.spin_strength_peak ?? 0;

  // Self-regulation escape valve (spec §2 rationale + baseline-spec §3.4.1):
  // When GUT+HEART are both tightly locked and spin is climbing, the user is
  // actively self-regulating; HEAD EEG volatility alone shouldn't mark the
  // window unstable or mixed.
  const gutTight   = baseline.GUT.mean   > cfg.regulated_mean_min && baseline.GUT.sd   < cfg.regulated_sd_max;
  const heartTight = baseline.HEART.mean > cfg.regulated_mean_min && baseline.HEART.sd < cfg.regulated_sd_max;
  const activeSelfRegulation = gutTight && heartTight && spinPeak > cfg.spin_active_threshold;

  // Noise robustness (targeted-selection spec §4.1): HEAD EEG often runs
  // noisier than HEART/GUT by its nature. A single noisy regime is not enough
  // to mark the whole window unstable — we require 2+ regimes above threshold.
  // This keeps the spirit of §3.2 ("wide variance = unreliable baseline")
  // while not flagging the common HEAD-only-noise case as unstable.
  if (noisyRegimes >= 2 && !activeSelfRegulation) {
    return CLASSIFICATIONS.UNSTABLE;
  }

  if (activeSelfRegulation) return CLASSIFICATIONS.REGULATED_ACTIVE;

  if (means.every(m => m > cfg.regulated_mean_min) &&
      sds.every(s => s < cfg.regulated_sd_max)) {
    return spinPeak > cfg.spin_active_threshold
      ? CLASSIFICATIONS.REGULATED_ACTIVE
      : CLASSIFICATIONS.REGULATED_STABLE;
  }

  if (means.every(m => m < cfg.dysregulated_mean_max)) {
    return CLASSIFICATIONS.DYSREGULATED;
  }

  return CLASSIFICATIONS.MIXED;
}

/**
 * Identify the lagging regime from baseline stats (lowest mean wins).
 * Ties broken by higher SD (more volatile = less reliable).
 * @param {BaselineInput} baseline
 * @returns {'GUT'|'HEART'|'HEAD'}
 */
export function deficitRegime(baseline) {
  const ranked = REGIMES
    .map(r => ({ r, mean: baseline[r].mean, sd: baseline[r].sd }))
    .sort((a, b) => a.mean - b.mean || b.sd - a.sd);
  return ranked[0].r;
}
