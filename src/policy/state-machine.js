// policy/state-machine.js
// Adaptive Prescription State Machine from Doc 3.
// STARTUP → BASELINE → ASSESS → PRESCRIBE → ENTRAIN → EVALUATE → CLOSING → COMPLETE
//
// This is the closed loop. Every transition is logged with a plain-English reason.

import { ArousalAnchor } from './arousal-anchor.js';
import { CascadeCursor, selectFirstFrequency, selectNextFrequency, onDirectionFlip } from './selection-rules.js';
import { evaluate } from './evaluate-rules.js';
import { mean, std } from '../math/stats.js';

const STATES = ['STARTUP', 'BASELINE', 'ASSESS', 'PRESCRIBE', 'ENTRAIN', 'EVALUATE', 'CLOSING', 'COMPLETE', 'PAUSE', 'ABORT'];

export class PolicyEngine {
  constructor(bus, config, library) {
    this.bus = bus;
    this.config = config || {};
    this.library = library || [];
    this._state = null;
    this._arousal = new ArousalAnchor(config.flip_margin || 0.10);
    this._cursor = new CascadeCursor();
    this._interval = null;
    this._unsubscribers = [];

    // Session state
    this._sessionStart = null;
    this._stateStart = null;
    this._baselineFeatures = [];
    // Calibrated 2026-04-17 after session analysis: absolute peak thresholds (e.g. 65) fail when user peaks top out at 45-72; capture per-session baseline TCS stats so "low peak" becomes relative to THIS user's baseline distribution.
    this._baselineTcsSamples = [];
    this._baselineTcsMean = null;
    this._baselineTcsStd = null;
    this._currentFrequency = null;
    this._frequencyHistory = [];
    this._tcsHistory = [];
    this._tcsAtEntry = 0;
    this._tcsMaxInState = 0;
    this._entryVector = null;
    this._consecutivePivots = 0;
    // Calibrated 2026-04-17 after session analysis: allow at most one slope-veto extension per prescription.
    this._slopeVetoUsed = false;
    // Calibrated 2026-04-17 after session analysis: adaptive ENTRAIN window — base 30s, 45s on extension or after the first pivot of the session.
    this._inExtension = false;
    this._hasPivotedEver = false;
    // Calibrated 2026-04-17 after session analysis: track session-max TCS and per-prescription peaks for CLOSE_ON_SUSTAINED_PEAK.
    this._sessionMaxTcs = 0;
    this._prescriptionPeaks = [];
    this._goalSustainStart = null;
    this._hugPeakTcs = 0;
    this._hugPeakLostSince = null;
    this._latestCoherence = null;
    this._latestFeatures = null;
  }

  get state() { return this._state; }
  get currentFrequency() { return this._currentFrequency; }
  get cascadeDirection() { return this._arousal.direction; }
  get arousalAnchor() { return this._arousal.anchor; }
  get sessionDuration() {
    return this._sessionStart ? (performance.now() / 1000 - this._sessionStart) : 0;
  }
  get stateDuration() {
    return this._stateStart ? (performance.now() / 1000 - this._stateStart) : 0;
  }

  /** Start a new session. */
  start() {
    this._sessionStart = performance.now() / 1000;

    // Subscribe to coherence and feature data
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_Coherence', (p) => { this._latestCoherence = p; }),
      this.bus.subscribe('Aetheria_Features', (p) => {
        if (p.type === 'all_features') this._latestFeatures = p;
      })
    );

    // Run the state machine at 1 Hz
    this._interval = setInterval(() => this._tick(), 1000);

    this._transition('STARTUP', 'Session started');
  }

  /** Stop the session. */
  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];

    this.bus.publish('Aetheria_Prescription', { action: 'stop' });
    this._transition('COMPLETE', 'Session stopped by user');
  }

  _transition(newState, reason) {
    const prev = this._state;
    this._state = newState;
    this._stateStart = performance.now() / 1000;

    const msg = prev ? `${prev} → ${newState}: ${reason}` : `${newState}: ${reason}`;
    console.log('Policy:', msg);

    this.bus.publish('Aetheria_State', {
      type: 'state_transition',
      from: prev,
      to: newState,
      reason,
      message: msg
    });
  }

  _tick() {
    const V = this._latestCoherence;
    const F = this._latestFeatures;
    const duration = this.stateDuration;

    switch (this._state) {
      case 'STARTUP':
        this._tickStartup();
        break;
      case 'BASELINE':
        this._tickBaseline(V, F, duration);
        break;
      case 'ASSESS':
        this._tickAssess(V);
        break;
      case 'PRESCRIBE':
        this._tickPrescribe(V);
        break;
      case 'ENTRAIN':
        this._tickEntrain(V, F, duration);
        break;
      case 'EVALUATE':
        this._tickEvaluate(V);
        break;
      case 'CLOSING':
        this._tickClosing(V, duration);
        break;
    }

    // Update session info on bus
    this.bus.publish('Aetheria_State', {
      type: 'session_info',
      state: this._state,
      frequency: this._currentFrequency,
      cascade: this._arousal.direction,
      anchor: this._arousal.anchor,
      sessionTime: this.sessionDuration,
      stateTime: this.stateDuration
    });
  }

  // --- State handlers ---

  _tickStartup() {
    // Check if sensors are streaming (we have coherence data)
    if (this._latestCoherence) {
      this._transition('BASELINE', 'Sensors active, capturing baseline (90s)');
    }
  }

  _tickBaseline(V, features, duration) {
    const baselineDuration = this.config.baseline_duration_sec || 90;

    // Collect features during baseline
    if (features) {
      this._baselineFeatures.push(features);
    }
    // Calibrated 2026-04-17 after session analysis: TCS stats drive the relative "low peak" threshold.
    if (V && isFinite(V.tcs)) {
      this._baselineTcsSamples.push(V.tcs);
    }

    if (duration >= baselineDuration && this._baselineFeatures.length >= 10) {
      // Compute baseline calibration
      this._calibrateBaseline();
      this._transition('ASSESS', `Baseline captured (${this._baselineFeatures.length} samples, ${baselineDuration}s)`);
    }
  }

  _calibrateBaseline() {
    // Build feature history for z-score calibration
    const history = {
      hrvCoherence: [], rmssd: [], hfNorm: [],
      hfPower: [], sd1: [], rsaAmplitude: [],
      alphaPowerNorm: [], thetaAlphaRatio: [], hbDiff: [], betaPower: []
    };

    for (const f of this._baselineFeatures) {
      if (f.heart) {
        if (f.heart.hrvCoherence != null) history.hrvCoherence.push(f.heart.hrvCoherence);
        if (f.heart.rmssd != null) history.rmssd.push(f.heart.rmssd);
        if (f.heart.hfNorm != null) history.hfNorm.push(f.heart.hfNorm);
      }
      if (f.gut) {
        if (f.gut.hfPower != null) history.hfPower.push(f.gut.hfPower);
        if (f.gut.sd1 != null) history.sd1.push(f.gut.sd1);
        if (f.gut.rsaAmplitude != null) history.rsaAmplitude.push(f.gut.rsaAmplitude);
      }
      if (f.head) {
        if (f.head.alphaPowerNorm != null) history.alphaPowerNorm.push(f.head.alphaPowerNorm);
        if (f.head.thetaAlphaRatio != null) history.thetaAlphaRatio.push(f.head.thetaAlphaRatio);
        if (f.head.hbDiff != null) history.hbDiff.push(f.head.hbDiff);
        if (f.head.betaPower != null) history.betaPower.push(f.head.betaPower);
      }
    }

    // Calibrate the coherence engine's z-scorers
    this.bus.publish('Aetheria_State', { type: 'calibrate_baseline', history });

    // Calibrated 2026-04-17 after session analysis: compute per-session TCS baseline stats (std floor prevents hair-trigger on unusually quiet baselines).
    if (this._baselineTcsSamples.length >= 10) {
      const stdFloor = this.config.baseline_tcs_std_floor ?? 3.0;
      this._baselineTcsMean = mean(this._baselineTcsSamples);
      this._baselineTcsStd = Math.max(std(this._baselineTcsSamples), stdFloor);
      console.log(`Policy: baseline TCS μ=${this._baselineTcsMean.toFixed(1)} σ=${this._baselineTcsStd.toFixed(1)} (n=${this._baselineTcsSamples.length})`);
    }

    // Set arousal anchor and initialise cascade cursor
    const lastFeatures = this._baselineFeatures[this._baselineFeatures.length - 1];
    const { initialDirection } = this._arousal.setAnchor(lastFeatures);
    this._cursor.reset(initialDirection);
  }

  _tickAssess(V) {
    if (!V) return;

    let freq;
    if (this._frequencyHistory.length === 0) {
      // First selection after baseline — uses cursor
      freq = selectFirstFrequency(V, this.library, this._cursor);
    } else {
      // Subsequent selection from EVALUATE hint — cursor advances
      const hint = this._lastHint || 'ADVANCE';
      freq = selectNextFrequency(
        hint, this._currentFrequency, V,
        this.library, this._frequencyHistory, this._cursor
      );
    }

    this._currentFrequency = freq;
    this._frequencyHistory.push(freq);

    this._transition('PRESCRIBE',
      `Selected ${freq.frequency_hz} Hz (${freq.regime} · ${freq.name} · ⌬${freq.digital_root}), cascade ${this._cursor.direction}`);
  }

  _tickPrescribe(V) {
    // Fire the prescription to the delivery coordinator
    const freq = this._currentFrequency;
    if (freq) {
      this.bus.publish('Aetheria_Prescription', {
        action: 'play',
        frequency: freq,
        crossfade_sec: this.config.crossfade_duration_sec || 4
      });
    }

    // Initialize ENTRAIN tracking
    this._tcsAtEntry = V ? V.tcs : 0;
    this._tcsMaxInState = V ? V.tcs : 0;
    this._tcsHistory = [];
    this._entryVector = V ? { ...V } : null;
    // Fresh prescription: reset slope-veto budget (at most one veto per prescription).
    this._slopeVetoUsed = false;
    // Fresh prescription: next ENTRAIN is a base window, not an extension.
    this._inExtension = false;

    this._transition('ENTRAIN',
      `Playing ${freq?.frequency_hz || '?'} Hz, entering entrainment`);
  }

  _tickEntrain(V, F, duration) {
    if (!V) return;

    // Calibrated 2026-04-17 after session analysis: extend to 45s on HOLD/veto extensions and on all base windows after the first pivot.
    const baseMin = this.config.entrain_min_duration_sec || 30;
    const extMin = this.config.entrain_extended_min_duration_sec ?? 45;
    const minDuration = (this._inExtension || this._hasPivotedEver) ? extMin : baseMin;
    const maxDuration = this.config.entrain_max_duration_sec || 180;

    // Track TCS
    this._tcsHistory.push(V.tcs);
    if (V.tcs > this._tcsMaxInState) this._tcsMaxInState = V.tcs;

    // v1.2: continuous drift monitoring — updateDrift called every second
    if (F) this._arousal.updateDrift(F, performance.now() / 1000);

    // Check termination conditions (Doc 3 §5)
    if (this._checkTermination(V)) return;

    // Transition to EVALUATE when conditions are met
    const slopeThreshold = this.config.plateau_slope_threshold || 0.1;
    const slope = this._tcsHistory.length >= 15
      ? Math.abs(this._tcsHistory.slice(-15).reduce((a, b) => a + b, 0) / 15 - V.tcs)
      : 1;

    const shouldEvaluate = duration >= minDuration && (
      (slope < slopeThreshold && duration >= minDuration + 15) || // plateau
      (V.tcs < this._tcsMaxInState - (this.config.decline_from_peak_threshold || 10)) || // decline
      duration >= maxDuration // max duration reached
    );

    if (shouldEvaluate) {
      this._transition('EVALUATE', `Evaluating after ${duration.toFixed(0)}s (TCS: ${V.tcs.toFixed(0)}, peak: ${this._tcsMaxInState.toFixed(0)})`);
    }
  }

  _tickEvaluate(V) {
    if (!V) return;

    // v1.2: check if the arousal anchor has queued a sustained direction flip
    const newDirection = this._arousal.consumePendingFlip();
    if (newDirection) {
      onDirectionFlip(newDirection, this._cursor);
      this._transition('ASSESS', `Cascade flipped to ${newDirection} based on sustained drift`);
      this._lastHint = 'PIVOT';
      return;
    }

    const result = evaluate({
      tcsHistory: this._tcsHistory,
      tcsNow: V.tcs,
      tcsAtEntry: this._tcsAtEntry,
      tcsMaxInState: this._tcsMaxInState,
      coherenceVector: V,
      entryVector: this._entryVector,
      baselineTcsMean: this._baselineTcsMean,
      baselineTcsStd: this._baselineTcsStd,
      slopeVetoAvailable: !this._slopeVetoUsed
    }, this.config);

    this._lastHint = result.decision;

    // Calibrated 2026-04-17 after session analysis: consume the per-prescription veto budget when applied.
    if (result.appliedSlopeVeto) {
      this._slopeVetoUsed = true;
    }

    // Track consecutive pivots
    if (result.decision === 'PIVOT') {
      this._consecutivePivots++;
      // Calibrated 2026-04-17 after session analysis: once any pivot has occurred, all subsequent base ENTRAIN windows extend to 45s.
      this._hasPivotedEver = true;
    } else {
      this._consecutivePivots = 0;
    }

    // Calibrated 2026-04-17 after session analysis: on prescription end (PIVOT/ADVANCE), record the window peak and run the close-on-sustained-peak check before dispatching.
    if (result.decision === 'PIVOT' || result.decision === 'ADVANCE') {
      this._prescriptionPeaks.push(this._tcsMaxInState);
      if (this._tcsMaxInState > this._sessionMaxTcs) {
        this._sessionMaxTcs = this._tcsMaxInState;
      }
      if (this._checkSustainedPeak()) return;
    }

    if (result.decision === 'HOLD') {
      // Calibrated 2026-04-17 after session analysis: HOLD or slope-veto re-entry is an extension, not a fresh base window.
      this._inExtension = true;
      // Re-enter ENTRAIN with same frequency
      this._transition('ENTRAIN', result.reason);
    } else {
      // ADVANCE or PIVOT → go to ASSESS for new frequency
      this._transition('ASSESS', `${result.decision}: ${result.reason}`);
    }
  }

  _tickClosing(V, duration) {
    if (!V) return;

    const minHug = this.config.hug_min_duration_sec || 45;
    const graceSec = this.config.hug_peak_lost_grace_sec || 3;

    // Track peak during closing
    if (V.tcs >= this._hugPeakTcs) {
      this._hugPeakTcs = V.tcs;
      this._hugPeakLostSince = null;
    } else {
      // Below peak
      if (this._hugPeakLostSince === null) {
        this._hugPeakLostSince = performance.now() / 1000;
      }
    }

    // End hug after minimum floor + peak lost for grace period
    const peakLostDuration = this._hugPeakLostSince
      ? (performance.now() / 1000 - this._hugPeakLostSince)
      : 0;

    if (duration >= minHug && peakLostDuration >= graceSec) {
      // Play the heartbeat end-signature
      this.bus.publish('Aetheria_Prescription', { action: 'heartbeat' });
      this._transition('COMPLETE', `Hug complete. Peak TCS: ${this._hugPeakTcs.toFixed(0)}, held for ${duration.toFixed(0)}s`);
      this._finish();
    }
  }

  // Calibrated 2026-04-17 after session analysis: CLOSE_ON_SUSTAINED_PEAK — coherence has settled at a meaningful peak; close gracefully on success.
  _checkSustainedPeak() {
    const minDur = this.config.success_min_duration_sec ?? 360;
    const ratio = this.config.sustain_ratio ?? 0.90;
    const windows = this.config.sustain_windows ?? 2;
    if (this.sessionDuration < minDur) return false;
    if (this._prescriptionPeaks.length < windows) return false;

    const peakK = this.config.peak_significance_k ?? 1.5;
    const significantPeak = (this._baselineTcsMean != null && this._baselineTcsStd != null)
      ? this._baselineTcsMean + peakK * this._baselineTcsStd
      : 65;
    if (this._sessionMaxTcs <= significantPeak) return false;

    const recent = this._prescriptionPeaks.slice(-windows);
    const floor = ratio * this._sessionMaxTcs;
    if (!recent.every(p => p >= floor)) return false;

    const recentStr = recent.map(p => p.toFixed(1)).join(', ');
    this._enterClosing(`coherence held — closing on peak (session_max=${this._sessionMaxTcs.toFixed(1)}, recent_peaks=[${recentStr}])`);
    return true;
  }

  _checkTermination(V) {
    const maxDuration = this.config.session_max_duration_sec || 1800;
    const goalTcs = this.config.goal_tcs_threshold || 80;
    const goalSustain = this.config.goal_sustain_duration_sec || 60;
    // Calibrated 2026-04-17 after session analysis: raised budget 3 → 4; three sessions closed at the prior cap before frequencies had converged.
    const maxPivots = this.config.pivot_budget ?? this.config.max_consecutive_pivots ?? 4;

    // Time cap
    if (this.sessionDuration >= maxDuration) {
      this._enterClosing('Time cap reached');
      return true;
    }

    // Goal reached: TCS >= 80 sustained for 60s
    if (V.tcs >= goalTcs) {
      if (!this._goalSustainStart) this._goalSustainStart = performance.now() / 1000;
      if ((performance.now() / 1000 - this._goalSustainStart) >= goalSustain) {
        this._enterClosing(`Goal reached: TCS ≥ ${goalTcs} sustained for ${goalSustain}s`);
        return true;
      }
    } else {
      this._goalSustainStart = null;
    }

    // Diminishing returns: 3 consecutive pivots
    if (this._consecutivePivots >= maxPivots) {
      this._enterClosing(`${maxPivots} consecutive pivots — diminishing returns`);
      return true;
    }

    return false;
  }

  _enterClosing(reason) {
    // Select closing frequency: leading regime, digital root 9, deepest octave
    const V = this._latestCoherence;
    const leadRegime = V?.lead || 'HEART';
    const closingFreqs = this.library
      .filter(f => f.regime === leadRegime && f.digital_root === 9)
      .sort((a, b) => a.frequency_hz - b.frequency_hz);

    const closingFreq = closingFreqs[0] || this._currentFrequency;
    this._currentFrequency = closingFreq;

    // Play closing frequency
    this.bus.publish('Aetheria_Prescription', {
      action: 'play',
      frequency: closingFreq,
      crossfade_sec: 4
    });

    this._hugPeakTcs = V?.tcs || 0;
    this._hugPeakLostSince = null;

    this._transition('CLOSING', `${reason}. Closing with ${closingFreq.frequency_hz} Hz (${leadRegime} · ${closingFreq.name})`);
  }

  _finish() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];

    // Stop audio after heartbeat completes
    setTimeout(() => {
      this.bus.publish('Aetheria_Prescription', { action: 'stop' });
    }, 5000);
  }
}
