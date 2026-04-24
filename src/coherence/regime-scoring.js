// coherence/regime-scoring.js
// Per-regime coherence scores from Doc 2 §2.4, §3.3, §4.4.
// Each regime score is a weighted sum of z-scored features,
// mapped through sigmoid to [0, 1].

import { sigmoid, ZScorer } from '../math/stats.js';

// Weight definitions from Doc 2
const HEART_WEIGHTS = { hrvCoherence: 0.50, rmssd: 0.25, hfNorm: 0.25 };
const GUT_WEIGHTS   = { hfPower: 0.40, sd1: 0.30, rsaAmplitude: 0.30 };
const HEAD_WEIGHTS  = { alphaPowerNorm: 0.35, thetaAlphaRatio: 0.25, hbDiff: 0.20, negBeta: 0.20 };

/**
 * Manages z-score baselines and computes regime scores.
 */
export class RegimeScorer {
  constructor() {
    // Z-scorers for each feature
    this._zScorers = {
      // HEART
      hrvCoherence: new ZScorer(),
      rmssd: new ZScorer(),
      hfNorm: new ZScorer(),
      // GUT
      hfPower: new ZScorer(),
      sd1: new ZScorer(),
      rsaAmplitude: new ZScorer(),
      // HEAD
      alphaPowerNorm: new ZScorer(),
      thetaAlphaRatio: new ZScorer(),
      hbDiff: new ZScorer(),
      betaPower: new ZScorer(),
    };

    this._calibrated = false;
  }

  get calibrated() { return this._calibrated; }

  /**
   * Reset all z-scorers and the calibrated flag. Call at the start of a new
   * session so stale calibration from the prior session cannot distort the
   * first samples before the new baseline's calibrate() runs.
   *
   * Bug discovered 2026-04-24 in session Joe-new-aetheria-session-2: the prior
   * session's high-HRV baseline left z-scorers clipping this session's normal
   * features at z=-4, producing sigmoid(~-3)≈0.045 with near-zero SD for GUT.
   */
  reset() {
    for (const scorer of Object.values(this._zScorers)) scorer.reset();
    this._calibrated = false;
  }

  /**
   * Calibrate z-scorers from baseline feature history.
   * Called at end of BASELINE state with arrays of feature values
   * collected over the 90-second baseline window.
   *
   * @param {object} history - { hrvCoherence: [...], rmssd: [...], ... }
   */
  calibrate(history) {
    for (const [key, scorer] of Object.entries(this._zScorers)) {
      if (history[key] && history[key].length >= 3) {
        scorer.calibrate(history[key]);
      }
    }
    this._calibrated = true;
  }

  /**
   * Score the HEART regime (Doc 2 §2.4).
   * HEART_score = z(HRV_Coherence) × 0.5 + z(RMSSD) × 0.25 + z(HF_norm) × 0.25
   *
   * @param {object} heartFeatures - from computeHeartFeatures()
   * @returns {{ raw: number, sigmoid: number }} raw z-weighted score and sigmoid-mapped value
   */
  scoreHeart(heartFeatures) {
    if (!heartFeatures) return { raw: 0, sigmoid: 0.5 };

    const z = this._calibrated ? {
      hrvCoherence: this._zScorers.hrvCoherence.score(heartFeatures.hrvCoherence),
      rmssd: this._zScorers.rmssd.score(heartFeatures.rmssd),
      hfNorm: this._zScorers.hfNorm.score(heartFeatures.hfNorm),
    } : {
      // Pre-baseline: use raw features with rough normalization
      hrvCoherence: (heartFeatures.hrvCoherence - 1) / 2,
      rmssd: (heartFeatures.rmssd - 40) / 20,
      hfNorm: (heartFeatures.hfNorm - 0.3) / 0.2,
    };

    const raw = z.hrvCoherence * HEART_WEIGHTS.hrvCoherence
              + z.rmssd * HEART_WEIGHTS.rmssd
              + z.hfNorm * HEART_WEIGHTS.hfNorm;

    return { raw, sigmoid: sigmoid(raw) };
  }

  /**
   * Score the GUT regime (Doc 2 §3.3).
   * GUT_score = z(HF_power) × 0.4 + z(SD1) × 0.3 + z(RSA_amplitude) × 0.3
   */
  scoreGut(gutFeatures) {
    if (!gutFeatures) return { raw: 0, sigmoid: 0.5 };
    // Guard: if any feature is NaN, substitute 0
    const safe = (v) => isFinite(v) ? v : 0;

    const hf = safe(gutFeatures.hfPower);
    const s1 = safe(gutFeatures.sd1);
    const rsa = safe(gutFeatures.rsaAmplitude);

    const z = this._calibrated ? {
      hfPower: this._zScorers.hfPower.score(hf),
      sd1: this._zScorers.sd1.score(s1),
      rsaAmplitude: this._zScorers.rsaAmplitude.score(rsa),
    } : {
      hfPower: hf > 0 ? Math.log10(hf + 1e-10) / 3 + 1 : 0,
      sd1: (s1 - 15) / 15,
      rsaAmplitude: rsa > 0 ? (rsa - 10) / 20 : 0,
    };

    const raw = z.hfPower * GUT_WEIGHTS.hfPower
              + z.sd1 * GUT_WEIGHTS.sd1
              + z.rsaAmplitude * GUT_WEIGHTS.rsaAmplitude;

    const result = isFinite(raw) ? raw : 0;
    return { raw: result, sigmoid: sigmoid(result) };
  }

  /**
   * Score the HEAD regime (Doc 2 §4.4).
   * HEAD_score = z(Alpha_norm) × 0.35 + z(Theta/Alpha) × 0.25
   *            + z(HbDiff) × 0.20 + z(-Beta) × 0.20
   */
  scoreHead(headFeatures) {
    if (!headFeatures) return { raw: 0, sigmoid: 0.5 };

    const z = this._calibrated ? {
      alphaPowerNorm: this._zScorers.alphaPowerNorm.score(headFeatures.alphaPowerNorm),
      thetaAlphaRatio: this._zScorers.thetaAlphaRatio.score(headFeatures.thetaAlphaRatio),
      hbDiff: this._zScorers.hbDiff.score(headFeatures.hbDiff),
      negBeta: -this._zScorers.betaPower.score(headFeatures.betaPower), // high beta = less coherent
    } : {
      alphaPowerNorm: (headFeatures.alphaPowerNorm - 0.2) / 0.1,
      thetaAlphaRatio: (headFeatures.thetaAlphaRatio - 0.8) / 0.3,
      hbDiff: headFeatures.hbDiff / 0.01,
      negBeta: -(headFeatures.betaPower - 0.2) / 0.1,
    };

    const raw = z.alphaPowerNorm * HEAD_WEIGHTS.alphaPowerNorm
              + z.thetaAlphaRatio * HEAD_WEIGHTS.thetaAlphaRatio
              + z.hbDiff * HEAD_WEIGHTS.hbDiff
              + z.negBeta * HEAD_WEIGHTS.negBeta;

    return { raw, sigmoid: sigmoid(raw) };
  }
}
