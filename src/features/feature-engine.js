// features/feature-engine.js
// Orchestrates all feature extraction at 1 Hz.
// Subscribes to raw sensor streams via the event bus, maintains rolling
// buffers, computes features from Doc 2, and publishes to Aetheria_Features.

import { computeHeartFeatures } from './heart-features.js';
import { computeGutFeatures } from './gut-features.js';
import { computeHeadFeatures } from './head-features.js';
import { estimateRespiration } from './respiration.js';

const WINDOW_SEC = 60; // rolling window for feature computation
const UPDATE_HZ = 1;   // feature update rate

export class FeatureEngine {
  /**
   * @param {EventBus} bus
   * @param {SensorHealthMonitor} [health] - optional; when provided, stale
   *   sensor streams are detected and their buffers cleared so downstream
   *   feature functions return null instead of stale values.
   */
  constructor(bus, health) {
    this.bus = bus;
    this._health = health || null;
    this._interval = null;
    this._unsubscribers = [];

    // Rolling buffers
    this._rr = { values: [], timestamps: [] };
    this._eeg = { TP9: [], AF7: [], AF8: [], TP10: [] };
    this._ppg = [];
    this._fnirsLatest = null;

    // Baseline (set during BASELINE state)
    this._baseline = null;
    this._iaf = null;

    // Latest computed features
    this.latestFeatures = null;
  }

  start() {
    // Subscribe to sensor streams
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_RR', (p) => {
        if (p.rr_ms !== null && p.rr_ms > 0) {
          this._rr.values.push(p.rr_ms);
          this._rr.timestamps.push(p.timestamp);
          this._trimBuffer(this._rr, WINDOW_SEC);
        }
      })
    );

    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_EEG', (p) => {
        // Handle batched EEG data
        if (p.batch) {
          for (const ch of Object.keys(p.batch)) {
            if (this._eeg[ch]) {
              const vals = p.batch[ch];
              for (let i = 0; i < vals.length; i++) this._eeg[ch].push(vals[i]);
              if (this._eeg[ch].length > 1024) this._eeg[ch] = this._eeg[ch].slice(-1024);
            }
          }
        } else if (p.channel && this._eeg[p.channel]) {
          // Legacy single-sample format
          this._eeg[p.channel].push(p.value);
          if (this._eeg[p.channel].length > 1024) this._eeg[p.channel] = this._eeg[p.channel].slice(-1024);
        }
      })
    );

    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_PPG', (p) => {
        // Handle batched PPG data
        if (p.batch && Array.isArray(p.batch)) {
          for (const v of p.batch) this._ppg.push(v);
        } else if (p.value != null) {
          this._ppg.push(p.value);
        }
        if (this._ppg.length > 960) this._ppg = this._ppg.slice(-960);
      })
    );

    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_fNIRS', (p) => {
        this._fnirsLatest = { hbO: p.hbO, hbR: p.hbR };
      })
    );

    // Run feature extraction at 1 Hz
    this._interval = setInterval(() => this._compute(), 1000 / UPDATE_HZ);
    console.log('FeatureEngine: started at 1 Hz');
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  /** Set the baseline from the first 90s of data (called by policy engine). */
  setBaseline(features) {
    this._baseline = features;
    console.log('FeatureEngine: baseline set');
  }

  /** Set IAF (computed once at baseline). */
  setIAF(iaf) {
    this._iaf = iaf;
    console.log('FeatureEngine: IAF =', iaf);
  }

  _trimBuffer(buf, maxSec) {
    if (buf.timestamps.length === 0) return;
    const cutoff = buf.timestamps[buf.timestamps.length - 1] - maxSec;
    while (buf.timestamps.length > 0 && buf.timestamps[0] < cutoff) {
      buf.values.shift();
      buf.timestamps.shift();
    }
  }

  _compute() {
    const features = {};
    let hasAny = false;

    // --- HEART features ---
    const heartFeatures = computeHeartFeatures(this._rr.values, this._rr.timestamps);
    if (heartFeatures) {
      Object.assign(features, { heart: heartFeatures });
      hasAny = true;
    }

    // --- GUT features ---
    if (heartFeatures) {
      const gutFeatures = computeGutFeatures(heartFeatures, this._rr.values, this._rr.timestamps);
      if (gutFeatures) {
        Object.assign(features, { gut: gutFeatures });
      }
    }

    // --- HEAD features ---
    // If EEG stream is stale (sensor disconnected), clear the buffer so
    // computeHeadFeatures sees insufficient data and returns null rather
    // than recomputing from the same stale samples indefinitely.
    if (this._health && this._health.isStale('Aetheria_EEG')) {
      this._eeg = { TP9: [], AF7: [], AF8: [], TP10: [] };
    }
    if (this._health && this._health.isStale('Aetheria_fNIRS')) {
      this._fnirsLatest = null;
    }

    const headFeatures = computeHeadFeatures(this._eeg, 256, this._fnirsLatest, this._iaf);
    if (headFeatures) {
      Object.assign(features, { head: headFeatures });
      // Store IAF from first computation if not set yet
      if (!this._iaf && headFeatures.iaf) {
        this._iaf = headFeatures.iaf;
      }
      hasAny = true;
    }

    // --- Respiration (from PPG) ---
    if (this._ppg.length >= 640) {
      const resp = estimateRespiration(this._ppg, 64);
      if (resp) {
        features.respiration = resp;
      }
    }

    if (!hasAny) return;

    this.latestFeatures = features;

    // Publish to bus
    this.bus.publish('Aetheria_Features', {
      ...features,
      type: 'all_features',
      hasBaseline: this._baseline !== null
    });
  }
}
