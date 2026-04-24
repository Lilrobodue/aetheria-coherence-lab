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
import { PhaseTransitionDetector } from './phase-transition.js';
import { lowpass, resampleLinear } from '../math/filters.js';

/**
 * Compose BCS from its three components, tolerating a null sharedEnergy.
 * Calibrated 2026-04-17 after session analysis: on ticks where MEMD could
 * not produce a valid sharedEnergy, we rescale the kuramoto and mutualInfo
 * weights to sum to the original total so BCS remains comparable across
 * "full" and "partial" ticks rather than being dragged toward zero by a
 * missing 35% weight slot.
 *
 * @param {{kuramoto:number, sharedEnergy:number|null, mutualInfo:number}} c
 * @param {{kuramoto:number, shared_energy:number, mutual_info:number}} w
 * @returns {{ bcs: number|null, quality: 'full'|'partial'|'unavailable' }}
 */
export function composeBcs(c, w) {
  const kValid = isFinite(c.kuramoto);
  const seValid = c.sharedEnergy != null && isFinite(c.sharedEnergy);
  const miValid = isFinite(c.mutualInfo);

  if (kValid && seValid && miValid) {
    const bcs = 100 * (w.kuramoto * c.kuramoto + w.shared_energy * c.sharedEnergy + w.mutual_info * c.mutualInfo);
    return { bcs, quality: 'full' };
  }
  if (kValid && miValid) {
    // SE absent — rescale K and MI weights to sum to the original total so
    // the score is on the same scale as a "full" tick.
    const origSum = w.kuramoto + w.shared_energy + w.mutual_info;
    const partialSum = w.kuramoto + w.mutual_info;
    const scale = origSum / partialSum;
    const bcs = 100 * scale * (w.kuramoto * c.kuramoto + w.mutual_info * c.mutualInfo);
    return { bcs, quality: 'partial' };
  }
  return { bcs: null, quality: 'unavailable' };
}

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

    // BCS history kept for any future analysis (rolling buffer).
    this._bcsHistory = [];

    // Phase transition detector (stateful, hysteresis-based — see phase-transition.js).
    this._ptDetector = new PhaseTransitionDetector();

    // Latest values — null until first successful compute.
    this.latestBCS = null;
    this.latestBCSQuality = null;
    this.latestComponents = { kuramoto: null, sharedEnergy: null, sharedEnergyQuality: null, mutualInfo: null };
    // Kept to old shape for backward compat with state-machine / viz consumers.
    // `time` is the most recent fire time; `magnitude` is unused in the
    // hysteresis model (carried as null) — consumers only check `.detected`.
    this.phaseTransition = { detected: false, time: null, magnitude: null, window: 0, durationTicks: 0 };

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

  /**
   * Reset per-session state so a new session starts with a clean slate.
   * Called from main.js at session-start alongside the CoherenceEngine +
   * FeatureEngine resets. Without this, the prior session's BCS history
   * and phase-transition detector state would carry forward.
   */
  reset() {
    this._gutValues = [];
    this._gutTimestamps = [];
    this._heartValues = [];
    this._heartTimestamps = [];
    this._headValues = [];
    this._headTimestamps = [];
    this._bcsHistory = [];
    this._ptDetector.reset();
    this._sessionStartSec = null;
    this.latestBCS = null;
    this.latestBCSQuality = null;
    this.latestComponents = { kuramoto: null, sharedEnergy: null, sharedEnergyQuality: null, mutualInfo: null };
    this.phaseTransition = { detected: false, time: null, magnitude: null, window: 0, durationTicks: 0 };
    console.log('BCSEngine: reset for new session');
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

    // 2. Shared mode energy fraction (generative unity via MEMD).
    // Calibrated 2026-04-17 after session analysis: sharedModeEnergyFraction
    // now returns {value, quality} so we can distinguish null ("no
    // measurement") from a legitimate numeric 0 ("no shared modes").
    let seResult;
    try {
      seResult = sharedModeEnergyFraction([gutEnv, heartEnv, headEnv]);
    } catch (e) {
      console.warn('BCS MEMD error:', e.message);
      seResult = { value: null, quality: 'nan_guard', reason: e.message };
    }
    // Defensive: any non-finite number becomes null + nan_guard.
    if (seResult.value != null && !isFinite(seResult.value)) {
      seResult = { value: null, quality: 'nan_guard', reason: 'non_finite' };
    }

    // 3. Normalized mutual information (informational unity)
    const mutualInfo = meanPairwiseNMI([gutEnv, heartEnv, headEnv]);

    // Composite BCS — if SE is null, rescale K+MI weights to fill the gap.
    const w = this.config.bcs_weights || { kuramoto: 0.40, shared_energy: 0.35, mutual_info: 0.25 };
    const kValid = isFinite(kuramoto);
    const seValid = seResult.value != null && isFinite(seResult.value);
    const miValid = isFinite(mutualInfo);
    const composed = composeBcs({ kuramoto, sharedEnergy: seResult.value, mutualInfo }, w);
    const bcs = composed.bcs;
    const bcsQuality = composed.quality;

    this.latestBCS = bcs;
    this.latestComponents = {
      kuramoto: kValid ? kuramoto : null,
      sharedEnergy: seValid ? seResult.value : null,
      sharedEnergyQuality: seResult.quality,
      mutualInfo: miValid ? mutualInfo : null
    };
    this.latestBCSQuality = bcsQuality;

    // Track BCS history (kept for analytics) and update the hysteresis
    // phase-transition detector. Null BCS samples are passed through as-is
    // so the detector can hold state without being tricked by synthetic zeros.
    const nowSec = performance.now() / 1000;
    if (bcs != null) {
      this._bcsHistory.push({ time: nowSec, bcs });
      if (this._bcsHistory.length > 200) this._bcsHistory.shift();
    }

    const sessionAge = this._sessionStartSec != null
      ? (nowSec - this._sessionStartSec)
      : Infinity;

    // Warmup suppression: inside the warmup window, don't let the detector
    // progress its consecutive counters — pretend the tick didn't happen.
    if (sessionAge >= this._warmupSec) {
      const ptState = this._ptDetector.update(bcs, nowSec);
      this.phaseTransition = {
        detected: ptState.active,
        time: ptState.fireTime,
        magnitude: null, // n/a in the level-hysteresis model
        window: ptState.window,
        durationTicks: ptState.durationTicks,
        justFired: ptState.justFired,
        justCleared: ptState.justCleared,
      };
    }

    // Publish
    this.bus.publish('Aetheria_BCS', {
      bcs,
      bcsQuality,
      kuramoto: this.latestComponents.kuramoto,
      sharedEnergy: this.latestComponents.sharedEnergy,
      sharedEnergyQuality: this.latestComponents.sharedEnergyQuality,
      mutualInfo: this.latestComponents.mutualInfo,
      phaseTransition: this.phaseTransition
    });

    const fmt = (v, d = 2) => v == null ? 'N/A' : v.toFixed(d);
    console.log(`BCS: ${fmt(bcs, 1)} [${bcsQuality}] (K:${fmt(kuramoto)} E:${fmt(seResult.value)}${seResult.quality !== 'ok' ? `/${seResult.quality}` : ''} MI:${fmt(mutualInfo)})` +
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
