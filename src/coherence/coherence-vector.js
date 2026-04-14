// coherence/coherence-vector.js
// CoherenceEngine: orchestrates regime scoring, cross-regime PLV,
// and TCS computation. Publishes the full CoherenceVector to the bus
// at 1 Hz (Doc 2 §6.2).

import { RegimeScorer } from './regime-scoring.js';
import { extractEnvelope, computeTriunePLV, detectHarmonicLock, ENVELOPE_BANDS } from './cross-regime.js';
import { computeTCS } from './tcs.js';

export class CoherenceEngine {
  constructor(bus, config) {
    this.bus = bus;
    this.config = config || {};
    this._scorer = new RegimeScorer();
    this._interval = null;
    this._unsubscribers = [];

    // Latest features from feature engine
    this._latestFeatures = null;

    // Envelope histories for cross-regime PLV (rolling 60s at ~1 Hz)
    this._heartEnvHistory = { values: [], timestamps: [] };
    this._gutEnvHistory = { values: [], timestamps: [] };
    this._headEnvHistory = { values: [], timestamps: [] };

    // Latest coherence vector
    this.latest = null;
  }

  get scorer() { return this._scorer; }

  start() {
    // Subscribe to features from the feature engine
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_Features', (p) => {
        if (p.type === 'all_features') {
          this._latestFeatures = p;
          this._updateEnvelopeHistory(p);
        }
      })
    );

    // Compute coherence at 1 Hz
    this._interval = setInterval(() => this._compute(), 1000);
    console.log('CoherenceEngine: started at 1 Hz');
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  /** Calibrate z-scorers from baseline data. */
  calibrate(featureHistory) {
    this._scorer.calibrate(featureHistory);
    console.log('CoherenceEngine: baseline calibrated');
  }

  _updateEnvelopeHistory(features) {
    const t = features.timestamp || performance.now() / 1000;

    // Heart envelope: instantaneous HR
    if (features.heart?.meanHR) {
      this._heartEnvHistory.values.push(features.heart.meanHR);
      this._heartEnvHistory.timestamps.push(t);
    }

    // Gut envelope: RSA amplitude (or HF power as proxy)
    if (features.gut?.rsaAmplitude !== undefined) {
      this._gutEnvHistory.values.push(features.gut.rsaAmplitude);
      this._gutEnvHistory.timestamps.push(t);
    } else if (features.gut?.hfPower !== undefined) {
      this._gutEnvHistory.values.push(features.gut.hfPower);
      this._gutEnvHistory.timestamps.push(t);
    }

    // Head envelope: alpha power
    if (features.head?.alphaPowerNorm !== undefined) {
      this._headEnvHistory.values.push(features.head.alphaPowerNorm);
      this._headEnvHistory.timestamps.push(t);
    }

    // Trim to 60 seconds
    const cutoff = t - 60;
    for (const buf of [this._heartEnvHistory, this._gutEnvHistory, this._headEnvHistory]) {
      while (buf.timestamps.length > 0 && buf.timestamps[0] < cutoff) {
        buf.values.shift();
        buf.timestamps.shift();
      }
    }
  }

  _compute() {
    const f = this._latestFeatures;
    if (!f) return;

    // --- Per-regime scores (null when regime is offline) ---
    const heart = f.heart ? this._scorer.scoreHeart(f.heart) : null;
    const gut   = f.gut   ? this._scorer.scoreGut(f.gut)     : null;
    const head  = f.head  ? this._scorer.scoreHead(f.head)   : null;

    // If head is offline, clear its envelope history so stale data
    // doesn't feed into PLV or harmonic lock.
    if (!f.head) {
      this._headEnvHistory.values.length = 0;
      this._headEnvHistory.timestamps.length = 0;
    }

    // --- Cross-regime coherence (bandpass into regime-specific bands) ---
    const gutEnv = extractEnvelope(
      this._gutEnvHistory.values, this._gutEnvHistory.timestamps,
      ENVELOPE_BANDS.gut
    );
    const heartEnv = extractEnvelope(
      this._heartEnvHistory.values, this._heartEnvHistory.timestamps,
      ENVELOPE_BANDS.heart
    );
    const headEnv = f.head
      ? extractEnvelope(
          this._headEnvHistory.values, this._headEnvHistory.timestamps,
          ENVELOPE_BANDS.head
        )
      : null;

    const { triunePLV, plvGH, plvHD, plvGD } = computeTriunePLV(gutEnv, heartEnv, headEnv);
    const harmonicLock = detectHarmonicLock(gutEnv, heartEnv, headEnv);

    // --- TCS with dynamic reweighting ---
    const { tcs, confidence } = computeTCS({
      gut:          gut?.sigmoid   ?? null,
      heart:        heart?.sigmoid ?? null,
      head:         head?.sigmoid  ?? null,
      triunePLV:    triunePLV,
      harmonicLock: harmonicLock,
    }, this.config.tcs_weights);

    // --- Deficit and lead detection (Doc 2 §6.2) ---
    // Only consider regimes that are actually online.
    const scores = [
      gut   && { name: 'GUT',   value: gut.sigmoid },
      heart && { name: 'HEART', value: heart.sigmoid },
      head  && { name: 'HEAD',  value: head.sigmoid },
    ].filter(Boolean);
    scores.sort((a, b) => a.value - b.value);

    const lead    = scores.length > 0 ? scores[scores.length - 1].name : 'NONE';
    const deficit = (scores.length >= 2 && scores[1].value - scores[0].value > 0.15)
      ? scores[0].name
      : 'NONE';

    // Debug: log regime scores periodically
    if (Math.random() < 0.1) { // ~every 10 seconds
      console.log('Coherence scores:', {
        gut:   gut   ? gut.sigmoid.toFixed(3)   : 'offline',
        heart: heart ? heart.sigmoid.toFixed(3) : 'offline',
        head:  head  ? head.sigmoid.toFixed(3)  : 'offline',
        plv: triunePLV !== null ? triunePLV.toFixed(3) : 'n/a',
        confidence: confidence.toFixed(2),
      });
    }

    // --- Build coherence vector ---
    const vector = {
      tcs,
      confidence,
      gut:      gut?.sigmoid   ?? null,
      heart:    heart?.sigmoid ?? null,
      head:     head?.sigmoid  ?? null,
      gutRaw:   gut?.raw       ?? null,
      heartRaw: heart?.raw     ?? null,
      headRaw:  head?.raw      ?? null,
      triunePLV,
      plvGH, plvHD, plvGD,
      harmonicLock,
      deficit,
      lead,
      calibrated: this._scorer.calibrated
    };

    this.latest = vector;

    // Publish to bus
    this.bus.publish('Aetheria_Coherence', vector);
  }
}
