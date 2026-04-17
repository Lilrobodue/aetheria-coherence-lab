// bcs/bcs-engine.js
// Biofield Coherence Score engine from Doc 5 §4.
//
// BCS = 100 × (0.40 × kuramoto_R + 0.35 × shared_energy + 0.25 × mutual_info)
//
// Runs at ~0.1 Hz (every 10-15 seconds) — slower than TCS because
// the computations (especially MEMD) are heavier. BCS is observational
// only — it watches the session but doesn't drive decisions.

import { kuramotoFromEnvelopes } from './kuramoto.js';
import { sharedModeEnergyFraction } from './memd.js';
import { meanPairwiseNMI } from './mutual-information.js';
import { detectPhaseTransition } from './phase-transition.js';
import { lowpass, resampleLinear } from '../math/filters.js';

export class BCSEngine {
  constructor(bus, config) {
    this.bus = bus;
    this.config = config || {};
    this._interval = null;
    this._unsubscribers = [];

    // Envelope histories (rolling 60s at 1 Hz from features)
    this._gutValues = [];
    this._gutTimestamps = [];
    this._heartValues = [];
    this._heartTimestamps = [];
    this._headValues = [];
    this._headTimestamps = [];

    // BCS history for phase transition detection
    this._bcsHistory = [];

    // Latest values
    this.latestBCS = 0;
    this.latestComponents = { kuramoto: 0, sharedEnergy: 0, mutualInfo: 0 };
    this.phaseTransition = { detected: false, time: null, magnitude: null };

    // Calibrated 2026-04-17 after session analysis: sensor settling produced a bogus phase_transition_time_seconds=1.69 in an observed session; suppress detections during warmup.
    this._sessionStartSec = null;
    this._warmupSec = (config && config.phase_transition_warmup_sec != null) ? config.phase_transition_warmup_sec : 20;
  }

  start() {
    this._sessionStartSec = null;
    // Calibrated 2026-04-17 after session analysis: the warmup window is session-relative, not app-relative — reset on STARTUP so pre-session feature accumulation doesn't exhaust it.
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_State', (p) => {
        if (p.type === 'state_transition' && p.to === 'STARTUP') {
          this._sessionStartSec = performance.now() / 1000;
        }
      })
    );
    // Subscribe to features for envelope accumulation
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_Features', (p) => {
        if (p.type !== 'all_features') return;
        const t = p.timestamp;

        // Gut envelope: RSA amplitude or HF power
        if (p.gut?.rsaAmplitude != null) {
          this._gutValues.push(p.gut.rsaAmplitude);
          this._gutTimestamps.push(t);
        }
        // Heart envelope: mean HR
        if (p.heart?.meanHR != null) {
          this._heartValues.push(p.heart.meanHR);
          this._heartTimestamps.push(t);
        }
        // Head envelope: alpha power
        if (p.head?.alphaPowerNorm != null) {
          this._headValues.push(p.head.alphaPowerNorm);
          this._headTimestamps.push(t);
        }

        // Trim to 60 seconds
        this._trimTo60s();
      })
    );

    // Compute BCS every 10 seconds
    this._interval = setInterval(() => this._compute(), 10000);
    console.log('BCSEngine: started at 0.1 Hz');
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  _trimTo60s() {
    const bufs = [
      [this._gutValues, this._gutTimestamps],
      [this._heartValues, this._heartTimestamps],
      [this._headValues, this._headTimestamps]
    ];
    for (const [vals, times] of bufs) {
      while (times.length > 60) { vals.shift(); times.shift(); }
    }
  }

  _compute() {
    // Need at least 20 samples in each envelope
    if (this._gutValues.length < 20 || this._heartValues.length < 20 || this._headValues.length < 20) {
      return;
    }

    // Resample envelopes to common 4 Hz grid
    const gutEnv = this._makeEnvelope(this._gutValues, this._gutTimestamps);
    const heartEnv = this._makeEnvelope(this._heartValues, this._heartTimestamps);
    const headEnv = this._makeEnvelope(this._headValues, this._headTimestamps);

    if (!gutEnv || !heartEnv || !headEnv) return;

    // 1. Kuramoto order parameter (phase unity)
    const kuramoto = kuramotoFromEnvelopes(gutEnv, heartEnv, headEnv);

    // 2. Shared mode energy fraction (generative unity via MEMD)
    let sharedEnergy = 0;
    try {
      sharedEnergy = sharedModeEnergyFraction([gutEnv, heartEnv, headEnv]);
    } catch (e) {
      console.warn('BCS MEMD error:', e.message);
    }

    // 3. Normalized mutual information (informational unity)
    const mutualInfo = meanPairwiseNMI([gutEnv, heartEnv, headEnv]);

    // Composite BCS (Doc 5 §4)
    const w = this.config.bcs_weights || { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
    const bcs = 100 * (
      w.kuramoto * (isFinite(kuramoto) ? kuramoto : 0) +
      w.shared_energy * (isFinite(sharedEnergy) ? sharedEnergy : 0) +
      w.mutual_info * (isFinite(mutualInfo) ? mutualInfo : 0)
    );

    this.latestBCS = isFinite(bcs) ? bcs : 0;
    this.latestComponents = {
      kuramoto: isFinite(kuramoto) ? kuramoto : 0,
      sharedEnergy: isFinite(sharedEnergy) ? sharedEnergy : 0,
      mutualInfo: isFinite(mutualInfo) ? mutualInfo : 0
    };

    // Track BCS history for phase transition detection
    this._bcsHistory.push({ time: performance.now() / 1000, bcs: this.latestBCS });
    if (this._bcsHistory.length > 200) this._bcsHistory.shift();

    this.phaseTransition = detectPhaseTransition(this._bcsHistory);

    // Calibrated 2026-04-17 after session analysis: sensor warmup can look like a phase transition; suppress any detection inside the warmup window.
    const sessionAge = this._sessionStartSec != null
      ? (performance.now() / 1000 - this._sessionStartSec)
      : Infinity;
    if (sessionAge < this._warmupSec && this.phaseTransition.detected) {
      this.phaseTransition = { detected: false, time: null, magnitude: null };
    }

    // Publish
    this.bus.publish('Aetheria_BCS', {
      bcs: this.latestBCS,
      kuramoto: this.latestComponents.kuramoto,
      sharedEnergy: this.latestComponents.sharedEnergy,
      mutualInfo: this.latestComponents.mutualInfo,
      phaseTransition: this.phaseTransition
    });

    console.log(`BCS: ${this.latestBCS.toFixed(1)} (K:${kuramoto.toFixed(2)} E:${sharedEnergy.toFixed(2)} MI:${mutualInfo.toFixed(2)})` +
      (this.phaseTransition.detected ? ` *** PHASE TRANSITION: +${this.phaseTransition.magnitude} ***` : ''));
  }

  _makeEnvelope(values, timestamps) {
    if (values.length < 16) return null;
    const { data } = resampleLinear(values, timestamps, 4);
    if (data.length < 16) return null;
    try {
      return lowpass(data, 0.5, 4);
    } catch {
      return data;
    }
  }
}
