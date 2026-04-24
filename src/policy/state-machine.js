// policy/state-machine.js
// Adaptive Prescription State Machine from Doc 3.
// STARTUP → BASELINE → ASSESS → PRESCRIBE → ENTRAIN → EVALUATE → CLOSING → COMPLETE
//
// This is the closed loop. Every transition is logged with a plain-English reason.

import { ArousalAnchor } from './arousal-anchor.js';
import { CascadeCursor, selectFirstFrequency, selectNextFrequency, onDirectionFlip } from './selection-rules.js';
import { evaluate } from './evaluate-rules.js';
import { mean, std } from '../math/stats.js';
import { classify, deficitRegime, CLASSIFICATIONS } from './baseline-classifier.js';
import { summarizeBaseline, spinStrength } from './baseline-stats.js';
import { runProtocol, resolveTargetRegime, selectCrossRegimeEscalation, selectClosingBridge } from './protocols.js';

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
    // Baseline character scalars (surfaced on state snapshot; available for
    // future prescription-engine classification after N≥10 sessions).
    this._baselineTcsMax = null;
    this._baselineTcsRange = null;
    this._baselineTcsPeakRate = null;
    // Sustaining mode: set true when baseline BCS is already unified (mean and
    // sustain-ratio both clear the BCS threshold). When true, the duration
    // floors on SUSTAINED_PEAK and UNIFIED_COHERENCE are bypassed so the
    // session can close on the first sustained peak.
    this._baselineBcsUnified = null;
    this._baselineBcsMean = null;
    this._currentFrequency = null;
    this._frequencyHistory = [];
    this._tcsHistory = [];
    this._tcsAtEntry = 0;
    this._tcsMaxInState = 0;
    this._entryVector = null;
    // Calibrated 2026-04-17 after session analysis: allow at most one slope-veto extension per prescription.
    this._slopeVetoUsed = false;
    // Calibrated 2026-04-17 after session analysis: adaptive ENTRAIN window — base 30s, 45s on extension or after the first pivot of the session.
    this._inExtension = false;
    this._hasPivotedEver = false;
    // Calibrated 2026-04-17 after session analysis: track session-max TCS and per-prescription peaks for CLOSE_ON_SUSTAINED_PEAK.
    this._sessionMaxTcs = 0;
    this._prescriptionPeaks = [];
    // Rolling buffer of recent BCS samples for CLOSE_ON_UNIFIED_COHERENCE.
    // Stored as { t (session-relative), bcs (number|null), bcsQuality }.
    // Trimmed to ~30 samples (~5 min at 0.1 Hz) to cover any reasonable
    // unified_bcs_window_sec.
    this._bcsSamples = [];
    // Rolling buffer of TCS samples at 1Hz for close-time trajectory logging.
    // Capped at 120 entries (~2 min) — long enough to cover the slope window.
    this._tcsSamples = [];
    this._goalSustainStart = null;
    this._hugPeakTcs = 0;
    this._hugPeakLostSince = null;
    this._latestCoherence = null;
    this._latestFeatures = null;

    // Baseline classifier layer (spec: coherence_lab_baseline_spec.md §3).
    // Raw windowed samples used to build baseline stats + the classifier input.
    this._baselineCoherenceSamples = [];
    this._baselineBcsSamples = [];
    this._baselineExtensionsUsed = 0;
    // Session-relative seconds at which the baseline phase ended and the
    // prescription phase began. Used by maintenance's completion timer.
    this._baselineEndTime = null;
    this._baselineStats = null;         // full summarizeBaseline() output
    this._classification = null;         // current arrival-state label
    this._lastRebaselineAt = 0;          // session-relative seconds
    this._phase = 'idle';                // 'idle' | 'baseline' | 'prescription' | 'quick_rebaseline'
    this._rollingGutSamples = [];        // {t, gut} — trimmed to 30s for foundation gating
    // Spin tracking post-baseline (used by maintenance protocol).
    this._spinCurrent = 0;
    this._spinPeakSinceBaseline = 0;
    this._spinDeclineSince = null;
    // First prescription has not fired yet — UI uses this for banner + chip.
    this._firstPrescriptionFired = false;

    // Regime-targeted selection (targeted-selection spec §3).
    // Target regime is resolved at first prescription (from baseline
    // deficit_majority) and held across prescriptions until the engine
    // determines the regime is exhausted and escalates.
    this._targetRegime = null;
    this._targetRegimeAttempts = 0;   // distinct frequencies tried in current regime
    this._targetRegimePeaks = [];     // TCS peak achieved per target-regime prescription
    this._targetRegimeCoherencePeaks = []; // regime-coherence peak (0-1) per target-regime prescription
    this._targetRegimeCoherenceMeans = []; // regime-coherence mean (0-1) per target-regime prescription
    this._regimeCoherenceMaxInState = 0;   // max target-regime coherence observed in current ENTRAIN
    this._regimeCoherenceSumInState = 0;   // accumulator for mean
    this._regimeCoherenceCountInState = 0;
    this._targetRegimeFreqs = new Set(); // frequency_hz values played while in this regime
    this._regimeHistory = [];         // [{regime, attempts, peaks, escalated:boolean, at:t}]
    // Last enriched reason block — attached to the next ASSESS→PRESCRIBE transition.
    this._lastSelectionLog = null;
  }

  get state() { return this._state; }
  get currentFrequency() { return this._currentFrequency; }
  get cascadeDirection() { return this._arousal.direction; }
  get arousalAnchor() { return this._arousal.anchor; }
  get phase() { return this._phase; }
  get classification() { return this._classification; }
  get baselineStats() { return this._baselineStats; }
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
      this.bus.subscribe('Aetheria_Coherence', (p) => {
        this._latestCoherence = p;
        const t = this.sessionDuration;
        if (p && p.tcs != null && isFinite(p.tcs)) {
          this._tcsSamples.push({ t, tcs: p.tcs });
          if (this._tcsSamples.length > 120) this._tcsSamples.shift();
        }
        if (p && this._phase === 'baseline') {
          this._baselineCoherenceSamples.push({
            t,
            gut: p.gut, heart: p.heart, head: p.head,
            harm: p.harmonicLock ?? null,
            triunePLV: p.triunePLV ?? null,
            deficit: p.deficit ?? null, // needed for baseline.deficit_majority vote (targeted-selection spec §3.1)
          });
        }
        if (p && p.gut != null && isFinite(p.gut)) {
          this._rollingGutSamples.push({ t, gut: p.gut });
          while (this._rollingGutSamples.length && t - this._rollingGutSamples[0].t > 30) {
            this._rollingGutSamples.shift();
          }
        }
      }),
      this.bus.subscribe('Aetheria_Features', (p) => {
        if (p.type === 'all_features') this._latestFeatures = p;
      }),
      // Calibrated 2026-04-17: buffer BCS samples for CLOSE_ON_UNIFIED_COHERENCE.
      this.bus.subscribe('Aetheria_BCS', (p) => {
        const t = this.sessionDuration;
        this._bcsSamples.push({
          t,
          bcs: p.bcs,
          bcsQuality: p.bcsQuality || null
        });
        if (this._bcsSamples.length > 30) this._bcsSamples.shift();
        if (this._phase === 'baseline') {
          this._baselineBcsSamples.push({ t, kuramoto: p.kuramoto ?? null, bcs: p.bcs, bcsQuality: p.bcsQuality });
        }
        // Track spin_strength for post-baseline maintenance protocol.
        if (this._phase !== 'baseline' && this._latestFeatures) {
          const f = this._latestFeatures;
          const s = spinStrength({
            hrvCoherence: f.heart?.hrvCoherence,
            rmssd: f.heart?.rmssd,
            kuramoto: p.kuramoto,
          });
          this._spinCurrent = s;
          if (s >= this._spinPeakSinceBaseline) {
            this._spinPeakSinceBaseline = s;
            this._spinDeclineSince = null;
          } else if (this._spinDeclineSince == null) {
            this._spinDeclineSince = t;
          }
        }
        // Phase-transition event triggers an immediate quick re-baseline.
        if (p.phaseTransition?.detected && this._phase === 'prescription') {
          this._requestQuickRebaseline('phase transition detected');
        }
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

    // Reason is either a string or an enriched object (from _applyPick).
    // When an object, the human-readable line is `reason.reason`.
    const isObj = reason && typeof reason === 'object';
    const reasonStr = isObj ? reason.reason : reason;
    const msg = prev ? `${prev} → ${newState}: ${reasonStr}` : `${newState}: ${reasonStr}`;
    console.log('Policy:', msg);

    const payload = {
      type: 'state_transition',
      from: prev,
      to: newState,
      reason: reasonStr,
      message: msg,
    };
    if (isObj) {
      payload.classification = reason.classification ?? null;
      payload.target_regime = reason.target_regime ?? null;
      payload.target_regime_rationale = reason.target_regime_rationale ?? null;
      payload.candidate_pool = reason.candidate_pool ?? [];
      payload.selected = reason.selected ?? null;
      payload.selection_rationale = reason.selection_rationale ?? null;
      payload.source = reason.source ?? null;
    }
    this.bus.publish('Aetheria_State', payload);
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
      stateTime: this.stateDuration,
      phase: this._phase,
      classification: this._classification,
    });

    // Periodic quick re-baseline during an active session (spec §3.5).
    if (this._phase === 'prescription') {
      const cadence = this.config.rebaseline_interval_sec ?? 300;
      if (this.sessionDuration - this._lastRebaselineAt >= cadence) {
        this._requestQuickRebaseline('periodic cadence');
      }
    }
  }

  _publishPhase() {
    this.bus.publish('Aetheria_State', {
      type: 'phase',
      phase: this._phase,
      classification: this._classification || null,
    });
  }

  // Quick re-baseline: samples a 30s window *without* pausing prescription,
  // then re-classifies. Classification may change mid-session (spec §3.5).
  _requestQuickRebaseline(reason) {
    if (this._quickRebaselineInFlight) return;
    this._quickRebaselineInFlight = true;
    this._lastRebaselineAt = this.sessionDuration;
    const window = this.config.rebaseline_quick_duration_sec ?? 30;
    const startT = this.sessionDuration;
    const prevPhase = this._phase;
    this._phase = 'quick_rebaseline';
    this._publishPhase();
    console.log(`Policy: quick re-baseline (${window}s) — ${reason}`);

    setTimeout(() => {
      const endT = this.sessionDuration;
      // Build a stats object from the most recent window of coherence samples
      // we already have buffered on the engine.
      const window30 = this._baselineCoherenceSamples; // this buffer only fills during 'baseline'
      // For quick re-baseline we draw from the rolling buffers on live streams:
      const coh = [];
      // Use last `window` seconds of rollingGutSamples + _latestCoherence snapshots —
      // simpler: accumulate a transient buffer over the window.
      // (We scan the tcs buffer; it's sampled 1 Hz with full coherence fields absent,
      //  so for the classifier we fall back to the last snapshot + variance from rolling GUT.)
      const rolling = this._rollingGutSamples.filter(s => s.t >= startT && s.t <= endT);
      const meanGut = rolling.length ? rolling.reduce((a,s)=>a+s.gut,0)/rolling.length : null;
      // Re-classify only if we have enough data; otherwise keep prior label.
      if (rolling.length >= 10 && this._baselineStats) {
        const prev = this._classification;
        // Lightweight re-classification: replace GUT stats with this window's rolling values,
        // keep HEART/HEAD baseline as reference (they're slower-moving).
        const updated = {
          ...this._baselineStats,
          GUT: {
            mean: +meanGut.toFixed(3),
            sd: +Math.sqrt(rolling.reduce((a,s)=>a+(s.gut-meanGut)**2,0)/rolling.length).toFixed(3),
          },
        };
        const newClass = classify(updated, this.config.classifier);
        if (newClass !== prev) {
          console.log(`Policy: classification shifted ${prev} → ${newClass} after quick re-baseline`);
          this._classification = newClass;
          this.bus.publish('Aetheria_State', {
            type: 'classification_shift',
            from: prev, to: newClass,
            updated_baseline_GUT: updated.GUT,
          });
        }
      }
      this._phase = prevPhase;
      this._publishPhase();
      this._quickRebaselineInFlight = false;
    }, (this.config.rebaseline_quick_duration_sec ?? 30) * 1000);
  }

  // --- State handlers ---

  _tickStartup() {
    // Check if sensors are streaming (we have coherence data)
    if (this._latestCoherence) {
      const target = this.config.baseline_duration_sec || 90;
      this._phase = 'baseline';
      this._publishPhase();
      this._transition('BASELINE', `Sensors active, capturing baseline (${target}s)`);
    }
  }

  _tickBaseline(V, features, duration) {
    const target = this.config.baseline_duration_sec || 90;
    const minDur = this.config.baseline_min_sec ?? 60;
    const maxDur = this.config.baseline_max_sec ?? 120;
    const extSec = this.config.baseline_extension_sec ?? 30;
    const maxExt = this.config.baseline_max_extensions ?? 2;

    // Collect features during baseline
    if (features) {
      this._baselineFeatures.push(features);
    }
    // Calibrated 2026-04-17 after session analysis: TCS stats drive the relative "low peak" threshold.
    if (V && isFinite(V.tcs)) {
      this._baselineTcsSamples.push(V.tcs);
    }

    const reachedTarget = duration >= (target + this._baselineExtensionsUsed * extSec);
    const hardCap = duration >= maxDur;

    if ((reachedTarget || hardCap) && this._baselineFeatures.length >= 10) {
      this._calibrateBaseline();

      if (this._classification === CLASSIFICATIONS.UNSTABLE &&
          this._baselineExtensionsUsed < maxExt && !hardCap) {
        this._baselineExtensionsUsed++;
        this._transition('BASELINE',
          `Baseline unstable (ext ${this._baselineExtensionsUsed}/${maxExt}) — extending ${extSec}s`);
        this.bus.publish('Aetheria_State', {
          type: 'baseline_extended',
          extension: this._baselineExtensionsUsed,
          reason: 'high regime variance',
        });
        return;
      }

      this._phase = 'prescription';
      this._baselineEndTime = this.sessionDuration;
      this._publishPhase();
      this._transition('ASSESS',
        `Baseline captured (${this._baselineFeatures.length} samples, ${duration.toFixed(0)}s, ${this._classification || 'unknown'})`);
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
      this._baselineTcsMax = Math.max(...this._baselineTcsSamples);
      this._baselineTcsRange = this._baselineTcsMax - Math.min(...this._baselineTcsSamples);
      this._baselineTcsPeakRate = this._computeBaselinePeakRate(this._baselineTcsSamples);
      console.log(`Policy: baseline TCS μ=${this._baselineTcsMean.toFixed(1)} σ=${this._baselineTcsStd.toFixed(1)} max=${this._baselineTcsMax.toFixed(1)} range=${this._baselineTcsRange.toFixed(1)} peak_rate=${this._baselineTcsPeakRate.toFixed(1)}/min (n=${this._baselineTcsSamples.length})`);
    }

    // Sustaining-mode detection: is baseline BCS already unified? Uses the
    // same full-quality filter as CLOSE_ON_UNIFIED_COHERENCE so the two rules
    // agree on what "unified" means.
    const baselineDurationSec = this.config.baseline_duration_sec ?? 90;
    const bcsThreshold = this.config.bcs_significance_threshold ?? 64;
    const unifiedSustainRatio = this.config.baseline_bcs_unified_sustain_ratio ?? 0.70;
    const baselineBcs = this._bcsSamples.filter(s =>
      s.t < baselineDurationSec && s.bcsQuality === 'full' && s.bcs != null && isFinite(s.bcs)
    );
    if (baselineBcs.length >= 3) {
      const bcsMean = baselineBcs.reduce((a, b) => a + b.bcs, 0) / baselineBcs.length;
      const aboveCount = baselineBcs.filter(s => s.bcs >= bcsThreshold).length;
      const ratio = aboveCount / baselineBcs.length;
      this._baselineBcsMean = bcsMean;
      this._baselineBcsUnified = (bcsMean >= bcsThreshold) && (ratio >= unifiedSustainRatio);
      if (this._baselineBcsUnified) {
        console.log(`Policy: baseline already unified (BCS μ=${bcsMean.toFixed(1)}, ${Math.round(ratio * 100)}% ≥${bcsThreshold}) — sustaining mode active, success floor removed`);
      }
    }

    // Set arousal anchor and initialise cascade cursor
    const lastFeatures = this._baselineFeatures[this._baselineFeatures.length - 1];
    const { initialDirection } = this._arousal.setAnchor(lastFeatures);
    this._cursor.reset(initialDirection);

    // Per-regime stats + spin_strength + classification (spec §3.1, §3.2).
    const baselineStats = summarizeBaseline(
      this._baselineCoherenceSamples,
      this._baselineFeatures.map(f => ({
        t: f.timestamp != null ? (f.timestamp - this._sessionStart) : null,
        heart: f.heart, gut: f.gut, head: f.head, resp: f.respiration,
      })),
      this._baselineBcsSamples,
      { durationSec: this.stateDuration }
    );
    const classification = classify(baselineStats, this.config.classifier);
    baselineStats.classification = classification;
    this._baselineStats = baselineStats;
    this._classification = classification;
    // Seed the post-baseline spin tracker with the baseline peak so the
    // maintenance protocol can observe the natural decline.
    this._spinPeakSinceBaseline = baselineStats.spin_strength_peak || 0;
    this._spinCurrent = this._spinPeakSinceBaseline;
    this._spinDeclineSince = null;

    console.log(
      `Policy: classified '${classification}' — ` +
      `GUT=${baselineStats.GUT.mean}±${baselineStats.GUT.sd}, ` +
      `HEART=${baselineStats.HEART.mean}±${baselineStats.HEART.sd}, ` +
      `HEAD=${baselineStats.HEAD.mean}±${baselineStats.HEAD.sd}, ` +
      `spin_peak=${baselineStats.spin_strength_peak}`
    );

    this.bus.publish('Aetheria_State', {
      type: 'baseline_classified',
      classification,
      baseline: baselineStats,
    });
  }

  _tickAssess(V) {
    if (!V) return;

    let pick = null;

    const useBaseline = this.config.use_baseline !== false;
    const useTargeted = this.config.use_targeted_selection !== false;

    // Record the peak from the just-completed prescription (if any) against
    // the target regime so exhaustion can be judged.
    this._recordPriorRegimePeak();

    // Cross-regime escalation check BEFORE we re-enter the protocol:
    // if the target regime has had ≥N attempts and no peak meets the ratio,
    // escalate. For HEAD, a null return from escalation means "go to CLOSING".
    if (useTargeted && useBaseline && this._classification && this._targetRegime && this._shouldEscalateRegime()) {
      const fromRegime = this._targetRegime;
      const ctx = this._buildProtocolCtx(V);
      const escalation = selectCrossRegimeEscalation(fromRegime, ctx);
      this._regimeHistory.push({
        regime: fromRegime,
        attempts: this._targetRegimeAttempts,
        peaks: [...this._targetRegimePeaks],
        escalated: true,
        at: this.sessionDuration,
      });
      if (!escalation) {
        // HEAD exhausted with no viable next step — enter CLOSING directly.
        this._enterClosing(`${fromRegime} exhausted after ${this._targetRegimeAttempts} attempts (peaks: ${this._targetRegimePeaks.map(p => p.toFixed(0)).join(', ')})`);
        return;
      }
      // Advance target to the next regime; bridge tones keep from=target so
      // the bridge itself counts as "finishing" the prior regime.
      if (escalation.next_regime) {
        this._targetRegime = fromRegime; // bridge plays as the last tone of fromRegime
      } else {
        this._switchTargetRegime(escalation.target_regime);
      }
      this._applyPick(escalation, 'escalation');
      return;
    }

    const ctx = useBaseline && this._classification ? this._buildProtocolCtx(V) : null;
    if (ctx && useTargeted) {
      pick = runProtocol(ctx);
      if (!pick) {
        // Maintenance declined — let the user's own regulation continue.
        // Stay in ASSESS; the tick loop will retry next second.
        return;
      }
    } else if (ctx && !useTargeted) {
      // Baseline gating on, targeted selection off — protocol runs but
      // without regime caching (legacy behavior of yesterday's build).
      pick = runProtocol({ ...ctx, targetRegime: undefined });
      if (!pick) return;
    } else if (this._frequencyHistory.length === 0) {
      const freq = selectFirstFrequency(V, this.library, this._cursor);
      pick = {
        freq,
        rationale: 'deficit',
        target_regime: freq.regime,
        target_regime_rationale: 'legacy cascade (use_baseline=false)',
        candidate_pool: [freq.frequency_hz],
        selection_rationale: 'legacy engine first-prescription',
      };
    } else {
      const hint = this._lastHint || 'ADVANCE';
      const freq = selectNextFrequency(
        hint, this._currentFrequency, V,
        this.library, this._frequencyHistory, this._cursor
      );
      pick = {
        freq,
        rationale: hint === 'PIVOT' ? 'deficit' : 'closing',
        target_regime: freq.regime,
        target_regime_rationale: 'legacy cascade',
        candidate_pool: [freq.frequency_hz],
        selection_rationale: `legacy engine ${hint}`,
      };
    }

    // Set target regime on first prescription, or when a protocol indicates it.
    if (useTargeted && !this._targetRegime && pick.target_regime) {
      this._switchTargetRegime(pick.target_regime);
    }
    // Track that this frequency was played in the current target regime.
    if (this._targetRegime && pick.freq.regime === this._targetRegime) {
      this._targetRegimeFreqs.add(pick.freq.frequency_hz);
      this._targetRegimeAttempts = this._targetRegimeFreqs.size;
    }

    this._applyPick(pick, 'protocol');
  }

  _applyPick(pick, source) {
    this._currentFrequency = pick.freq;
    this._currentRationale = pick.rationale;
    this._frequencyHistory.push(pick.freq);

    const reasonObj = {
      reason: `Selected ${pick.freq.frequency_hz} Hz (${pick.freq.regime} · ${pick.freq.name} · ⌬${pick.freq.digital_root}) — ${pick.rationale}`,
      classification: this._classification || null,
      target_regime: pick.target_regime || null,
      target_regime_rationale: pick.target_regime_rationale || null,
      candidate_pool: pick.candidate_pool || [],
      selected: pick.freq.frequency_hz,
      selection_rationale: pick.selection_rationale || null,
      source,
    };
    this._lastSelectionLog = reasonObj;

    this._transition('PRESCRIBE', reasonObj);
  }

  _switchTargetRegime(newRegime) {
    if (this._targetRegime && this._targetRegime !== newRegime) {
      // Close out the prior regime in the history if not already.
      const last = this._regimeHistory[this._regimeHistory.length - 1];
      if (!last || last.regime !== this._targetRegime || !last.escalated) {
        this._regimeHistory.push({
          regime: this._targetRegime,
          attempts: this._targetRegimeAttempts,
          peaks: [...this._targetRegimePeaks],
          escalated: true,
          at: this.sessionDuration,
        });
      }
    }
    this._targetRegime = newRegime;
    this._targetRegimeAttempts = 0;
    this._targetRegimePeaks = [];
    this._targetRegimeCoherencePeaks = [];
    this._targetRegimeCoherenceMeans = [];
    this._regimeCoherenceMaxInState = 0;
    this._regimeCoherenceSumInState = 0;
    this._regimeCoherenceCountInState = 0;
    this._targetRegimeFreqs = new Set();
  }

  _recordPriorRegimePeak() {
    if (this._targetRegime && this._currentFrequency &&
        this._currentFrequency.regime === this._targetRegime &&
        isFinite(this._tcsMaxInState) && this._tcsMaxInState > 0) {
      this._targetRegimePeaks.push(this._tcsMaxInState);
      if (isFinite(this._regimeCoherenceMaxInState) && this._regimeCoherenceMaxInState > 0) {
        this._targetRegimeCoherencePeaks.push(this._regimeCoherenceMaxInState);
      }
      if (this._regimeCoherenceCountInState > 0) {
        const m = this._regimeCoherenceSumInState / this._regimeCoherenceCountInState;
        if (isFinite(m)) this._targetRegimeCoherenceMeans.push(m);
      }
    }
  }

  // Cross-regime escalation (targeted-selection spec §3.3, sustain-based
  // tuning applied 2026-04-24 after session Joe-aetheria-session-4):
  //
  // The spec's peaks-only rule proved too lenient in practice — session 4 ran
  // 11 HEART prescriptions over 15 minutes with strong peaks (up to 0.83) but
  // a *post-baseline regime coherence mean* of 0.463 against a baseline of
  // 0.445 (basically no sustain). The peak-based rule would not escalate;
  // the sustain-based rule does.
  //
  // Sustain rule: escalate when, over the last N prescriptions, the mean of
  // per-prescription regime-coherence means fails to climb above
  // baseline_regime_mean + regime_exhaustion_mean_delta.
  _shouldEscalateRegime() {
    const minAttempts = this.config.regime_exhaustion_attempts ?? 3;
    const delta = this.config.regime_exhaustion_mean_delta ?? 0.10;
    if (this._targetRegimeAttempts < minAttempts) return false;
    if (this._targetRegimeCoherenceMeans.length < minAttempts) return false;
    const regimeBaseline = this._baselineStats?.[this._targetRegime]?.mean;
    if (regimeBaseline == null || !isFinite(regimeBaseline)) return false;
    const recent = this._targetRegimeCoherenceMeans.slice(-minAttempts);
    const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const sustainFloor = regimeBaseline + delta;
    return recentMean < sustainFloor;
  }

  _buildProtocolCtx(V) {
    const rolling = this._rollingGutSamples;
    const gutRollingMean = rolling.length
      ? rolling.reduce((a, s) => a + s.gut, 0) / rolling.length
      : (V.gut || 0);
    return {
      classification: this._classification,
      baseline: this._baselineStats,
      coherence: V,
      history: this._frequencyHistory,
      library: this.library,
      spin: {
        current: this._spinCurrent,
        peakSinceBaseline: this._spinPeakSinceBaseline,
        declining: this._spinDeclineSince != null &&
                   (this.sessionDuration - this._spinDeclineSince) >= 10 &&
                   this._spinCurrent < 0.7 * this._spinPeakSinceBaseline,
      },
      gutRolling: { mean: gutRollingMean, n: rolling.length },
      targetRegime: this._targetRegime,
      targetRegimePeaks: this._targetRegimePeaks,
      timeSinceBaseline: this._baselineEndTime != null
        ? this.sessionDuration - this._baselineEndTime
        : 0,
      maintenanceCompletionTimeoutSec: this.config.maintenance_completion_timeout_sec ?? 180,
    };
  }

  _tickPrescribe(V) {
    // Fire the prescription to the delivery coordinator
    const freq = this._currentFrequency;
    if (freq) {
      const baseline = this._baselineStats;
      this.bus.publish('Aetheria_Prescription', {
        action: 'play',
        frequency: freq,
        crossfade_sec: this.config.crossfade_duration_sec || 4,
        rationale: this._currentRationale || 'deficit',
        classification_at_fire: this._classification || null,
        baseline_ref: baseline ? {
          GUT_mean:   baseline.GUT?.mean   ?? null,
          HEART_mean: baseline.HEART?.mean ?? null,
          HEAD_mean:  baseline.HEAD?.mean  ?? null,
        } : null,
      });
      this._firstPrescriptionFired = true;
    }

    // Initialize ENTRAIN tracking
    this._tcsAtEntry = V ? V.tcs : 0;
    this._tcsMaxInState = V ? V.tcs : 0;
    this._tcsHistory = [];
    this._entryVector = V ? { ...V } : null;
    // Target-regime coherence peak + mean trackers (0-1 scale), reset each prescription.
    const regimeKey = this._targetRegime ? this._targetRegime.toLowerCase() : null;
    this._regimeCoherenceMaxInState = (V && regimeKey && isFinite(V[regimeKey])) ? V[regimeKey] : 0;
    this._regimeCoherenceSumInState = 0;
    this._regimeCoherenceCountInState = 0;
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

    // Track target-regime coherence peak + running mean (for sustain-based escalation).
    if (this._targetRegime) {
      const key = this._targetRegime.toLowerCase();
      const v = V[key];
      if (isFinite(v)) {
        if (v > this._regimeCoherenceMaxInState) this._regimeCoherenceMaxInState = v;
        this._regimeCoherenceSumInState += v;
        this._regimeCoherenceCountInState++;
      }
    }

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
      baselineTcsMax: this._baselineTcsMax,
      baselineTcsRange: this._baselineTcsRange,
      baselineTcsPeakRate: this._baselineTcsPeakRate,
      baselineBcsMean: this._baselineBcsMean,
      baselineBcsUnified: this._baselineBcsUnified,
      slopeVetoAvailable: !this._slopeVetoUsed
    }, this.config);

    this._lastHint = result.decision;

    // Calibrated 2026-04-17 after session analysis: consume the per-prescription veto budget when applied.
    if (result.appliedSlopeVeto) {
      this._slopeVetoUsed = true;
    }

    // Calibrated 2026-04-17 after session analysis: once any pivot has occurred, all subsequent base ENTRAIN windows extend to 45s.
    if (result.decision === 'PIVOT') {
      this._hasPivotedEver = true;
    }

    // Calibrated 2026-04-17 after session analysis: on prescription end (PIVOT/ADVANCE), record the window peak and run the close checks before dispatching.
    // Evaluation order: unified (preferred) → sustained-peak (TCS only) → stagnation.
    if (result.decision === 'PIVOT' || result.decision === 'ADVANCE') {
      this._prescriptionPeaks.push(this._tcsMaxInState);
      if (this._tcsMaxInState > this._sessionMaxTcs) {
        this._sessionMaxTcs = this._tcsMaxInState;
      }
      if (this._checkUnifiedCoherence()) return;
      if (this._checkSustainedPeak()) return;
      if (this._checkStagnation()) return;
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

  // Calibrated 2026-04-17 after session analysis: CLOSE_ON_UNIFIED_COHERENCE —
  // the therapeutically ideal outcome. TCS sustained at a significant peak
  // AND BCS sustained at unity-coherence magnitude over the trailing window.
  // Preferred over SUSTAINED_PEAK when both would fire, because it's a
  // strictly stronger claim.
  //
  // Tick handling for BCS samples in the trailing window:
  //   - { quality: 'full',  bcs >= threshold } → counts as valid sustain tick
  //   - { quality: 'full',  bcs <  threshold } → counts as valid, fails gate
  //                                              (correct for Path C "no
  //                                              shared modes" legitimate zeros)
  //   - { quality: 'partial' }    → skip, don't count, don't fail
  //   - { quality: 'unavailable' }→ skip, don't count, don't fail
  _checkUnifiedCoherence() {
    const minDur = this.config.unified_min_duration_sec ?? 360;
    if (this.sessionDuration < minDur && !this._baselineBcsUnified) return false;

    // TCS portion (identical to SUSTAINED_PEAK gate stack)
    const peakK = this.config.peak_significance_k ?? 1.5;
    const significantPeak = (this._baselineTcsMean != null && this._baselineTcsStd != null)
      ? this._baselineTcsMean + peakK * this._baselineTcsStd
      : 65;
    if (this._sessionMaxTcs <= significantPeak) return false;

    const sustainRatio = this.config.sustain_ratio ?? 0.85;
    const sustainWindows = this.config.sustain_windows ?? 2;
    const trailingWindows = this.config.trailing_max_windows ?? 3;
    if (this._prescriptionPeaks.length < sustainWindows) return false;
    const trailing = this._prescriptionPeaks.slice(-trailingWindows);
    const trailingMax = trailing.length >= trailingWindows
      ? Math.max(...trailing)
      : this._sessionMaxTcs;
    if (trailingMax <= significantPeak) return false;
    const recentTcs = this._prescriptionPeaks.slice(-sustainWindows);
    const tcsFloor = sustainRatio * trailingMax;
    if (!recentTcs.every(p => p >= tcsFloor)) return false;

    // BCS portion
    const bcsWindowSec = this.config.unified_bcs_window_sec ?? 120;
    const minValid = this.config.unified_bcs_min_valid_samples ?? 12;
    const bcsSustainRatio = this.config.unified_bcs_sustain_ratio ?? 0.85;
    const bcsThreshold = this.config.bcs_significance_threshold ?? 70;

    const now = this.sessionDuration;
    const inWindow = this._bcsSamples.filter(b => now - b.t <= bcsWindowSec);
    const valid = inWindow.filter(b =>
      b.bcsQuality === 'full' && b.bcs != null && isFinite(b.bcs)
    );
    if (valid.length < minValid) return false;
    const above = valid.filter(b => b.bcs >= bcsThreshold);
    if (above.length / valid.length < bcsSustainRatio) return false;

    const bcsMean = valid.reduce((a, b) => a + b.bcs, 0) / valid.length;
    if (this.sessionDuration < minDur && this._baselineBcsUnified) {
      const saved = minDur - this.sessionDuration;
      console.log(`Policy: sustaining-mode bypass — UNIFIED_COHERENCE fired at ${this.sessionDuration.toFixed(1)}s (normal gate at ${minDur}s, saved ${saved.toFixed(1)}s). Without bypass: would have continued entrainment.`);
    }
    this._enterClosing(
      `unified coherence held — TCS sustained=${recentTcs.length}/${sustainWindows}, BCS valid=${valid.length}, BCS above-threshold=${above.length}/${valid.length} (session_max_tcs=${this._sessionMaxTcs.toFixed(1)}, bcs_mean=${bcsMean.toFixed(1)})`
    );
    return true;
  }

  // Calibrated 2026-04-17 after session analysis: CLOSE_ON_SUSTAINED_PEAK — coherence has settled at a meaningful peak; close gracefully on success.
  //
  // The sustain floor uses a *trailing* max over the last trailing_max_windows
  // prescriptions rather than the all-time session_max_tcs. Rationale:
  // SUSTAIN asks "are we still performing at a high level?" which is naturally
  // a recent question; an exceptional early peak should not permanently raise
  // the bar beyond normal variance. The all-time session_max_tcs is still
  // used as the significance gate ("did we ever reach a real peak?") — only
  // the ratio floor is changed.
  //
  // STAGNATION continues to use session_max_tcs because it asks "did we fall
  // far below our best?" which requires an all-time reference.
  _checkSustainedPeak() {
    const minDur = this.config.success_min_duration_sec ?? 360;
    const ratio = this.config.sustain_ratio ?? 0.85;
    const windows = this.config.sustain_windows ?? 2;
    const trailingWindows = this.config.trailing_max_windows ?? 3;
    if (this.sessionDuration < minDur && !this._baselineBcsUnified) return false;
    if (this._prescriptionPeaks.length < windows) return false;

    const peakK = this.config.peak_significance_k ?? 1.5;
    const significantPeak = (this._baselineTcsMean != null && this._baselineTcsStd != null)
      ? this._baselineTcsMean + peakK * this._baselineTcsStd
      : 65;
    if (this._sessionMaxTcs <= significantPeak) return false;

    // Trailing-max reference: fall back to all-time session_max when fewer
    // than trailing_max_windows prescriptions have completed.
    const trailing = this._prescriptionPeaks.slice(-trailingWindows);
    const trailingMax = trailing.length >= trailingWindows
      ? Math.max(...trailing)
      : this._sessionMaxTcs;

    // Sustained success requires the recent cluster itself to be
    // therapeutically meaningful — not just tightly clustered internally.
    // Without this gate, a session that peaks high then settles into a low
    // plateau (e.g., peaked 86 then holds 54-58) fires SUSTAINED_PEAK
    // because trailing_max follows the decline down and a low floor (~49)
    // is easily cleared. That mislabels stagnation as success. Closing on
    // STAGNATION is the correct label for low-plateau sessions.
    if (trailingMax <= significantPeak) return false;

    const recent = this._prescriptionPeaks.slice(-windows);
    const floor = ratio * trailingMax;
    if (!recent.every(p => p >= floor)) return false;

    const recentStr = recent.map(p => p.toFixed(1)).join(', ');
    if (this.sessionDuration < minDur && this._baselineBcsUnified) {
      const saved = minDur - this.sessionDuration;
      console.log(`Policy: sustaining-mode bypass — SUSTAINED_PEAK fired at ${this.sessionDuration.toFixed(1)}s (normal gate at ${minDur}s, saved ${saved.toFixed(1)}s). Without bypass: would have continued entrainment.`);
    }
    this._enterClosing(`coherence held — closing on peak (session_max=${this._sessionMaxTcs.toFixed(1)}, trailing_max=${trailingMax.toFixed(1)}, recent_peaks=[${recentStr}])`);
    return true;
  }

  _checkTermination(V) {
    // Calibrated 2026-04-17 after session analysis: time cap halved to 15 min as a safety net, not a target. In a healthy session the sustained-peak or stagnation rule should fire first.
    const maxDuration = this.config.session_max_duration_sec || 900;
    const goalTcs = this.config.goal_tcs_threshold || 80;
    const goalSustain = this.config.goal_sustain_duration_sec || 60;

    // Time cap (safety net)
    if (this.sessionDuration >= maxDuration) {
      console.warn(`[policy] time-cap safety net fired at ${maxDuration}s — neither CLOSE_ON_SUSTAINED_PEAK nor CLOSE_ON_STAGNATION triggered; session did not converge.`);
      this._enterClosing('Time cap reached (safety net)');
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

    return false;
  }

  // Count local maxima in the baseline TCS series with prominence ≥ 0.5σ on at
  // least one side (filters sensor jitter). Returns peaks per minute.
  _computeBaselinePeakRate(samples) {
    if (samples.length < 3) return 0;
    const sigma = std(samples);
    const threshold = 0.5 * sigma;
    let peaks = 0;
    for (let i = 1; i < samples.length - 1; i++) {
      if (samples[i] > samples[i - 1] && samples[i] > samples[i + 1] &&
          (samples[i] - samples[i - 1] >= threshold || samples[i] - samples[i + 1] >= threshold)) {
        peaks++;
      }
    }
    const durationMin = (this.config.baseline_duration_sec ?? 90) / 60;
    return durationMin > 0 ? peaks / durationMin : 0;
  }

  // Calibrated 2026-04-18 after 3-session analysis: CLOSE_ON_STAGNATION detects
  // destabilization — the trailing prescription peaks sit below
  // baseline_mean − k·baseline_std, meaning the user's post-baseline state is
  // meaningfully worse than their resting state. Replaces the earlier
  // "fell from session_max" rule, which relied on an entrainment peak that
  // often never materialized when entrainment TCS ran below baseline TCS.
  _checkStagnation() {
    const k = this.config.destabilization_k_std ?? 1.0;
    const minRx = this.config.destabilization_min_prescriptions ?? 2;
    const windows = this.config.destabilization_windows ?? 2;

    if (this._baselineTcsMean == null || this._baselineTcsStd == null) return false;
    if (this._frequencyHistory.length < minRx) return false;

    const recent = this._prescriptionPeaks.slice(-windows);
    if (recent.length < windows) return false;

    const floor = this._baselineTcsMean - k * this._baselineTcsStd;
    const meanRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (meanRecent >= floor) return false;

    this._enterClosing(
      `destabilized — trailing peaks mean=${meanRecent.toFixed(1)} < baseline floor=${floor.toFixed(1)} (μ=${this._baselineTcsMean.toFixed(1)} σ=${this._baselineTcsStd.toFixed(1)}, k=${k})`
    );
    return true;
  }

  // Least-squares slope (value per 60s) across `samples` filtered to the last
  // `windowSec` seconds. Returns { slope, n }. slope is null when fewer than
  // 3 samples fall in the window or the time spread is zero.
  _slopePer60s(samples, windowSec, valueKey) {
    const now = this.sessionDuration;
    const recent = samples.filter(s =>
      s.t != null && now - s.t <= windowSec && s[valueKey] != null && isFinite(s[valueKey])
    );
    const n = recent.length;
    if (n < 3) return { slope: null, n };
    const tMean = recent.reduce((a, s) => a + s.t, 0) / n;
    const vMean = recent.reduce((a, s) => a + s[valueKey], 0) / n;
    let num = 0, den = 0;
    for (const s of recent) {
      const dt = s.t - tMean;
      num += dt * (s[valueKey] - vMean);
      den += dt * dt;
    }
    if (den === 0) return { slope: null, n };
    return { slope: (num / den) * 60, n };
  }

  _enterClosing(reason) {
    // Close-time trajectory — retrospective evidence for "was this close
    // premature?" Applies to every close path; not part of the reason string.
    const tcsTraj = this._slopePer60s(this._tcsSamples, 60, 'tcs');
    const bcsFull = this._bcsSamples.filter(s => s.bcsQuality === 'full');
    const bcsTraj = this._slopePer60s(bcsFull, 120, 'bcs');
    const fmt = (x) => x == null ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(1);
    let verdict;
    if (tcsTraj.slope != null && bcsTraj.slope != null) {
      if (tcsTraj.slope > 0 && bcsTraj.slope > 0) verdict = 'deepening at close';
      else if (tcsTraj.slope < 0 && bcsTraj.slope < 0) verdict = 'stable or declining';
      else verdict = 'mixed';
    } else {
      verdict = 'insufficient data';
    }
    console.log(`Policy: trajectory at close — TCS slope ${fmt(tcsTraj.slope)}/60s (n=${tcsTraj.n}), BCS slope ${fmt(bcsTraj.slope)}/60s (n=${bcsTraj.n}). Verdict: ${verdict}.`);

    // Closing selection: targeted-selection spec §4.5 chooses by whether the
    // targeted deficit was engaged and improved. Fallback = lead-regime root-9.
    const V = this._latestCoherence;
    const useTargeted = this.config.use_targeted_selection !== false;
    let closingFreq = null;
    if (useTargeted && this._targetRegime && this._baselineStats) {
      closingFreq = selectClosingBridge({
        library: this.library,
        baseline: this._baselineStats,
        liveCoherence: V,
        targetRegime: this._targetRegime,
        history: this._frequencyHistory,
      });
    }
    if (!closingFreq) {
      const leadRegime = V?.lead || 'HEART';
      const closingFreqs = this.library
        .filter(f => f.regime === leadRegime && f.digital_root === 9)
        .sort((a, b) => a.frequency_hz - b.frequency_hz);
      closingFreq = closingFreqs[0] || this._currentFrequency;
    }
    this._currentFrequency = closingFreq;

    // Play closing frequency
    this.bus.publish('Aetheria_Prescription', {
      action: 'play',
      frequency: closingFreq,
      crossfade_sec: 4,
      rationale: 'closing',
      classification_at_fire: this._classification,
      baseline_ref: this._baselineStats ? {
        GUT_mean:   this._baselineStats.GUT?.mean   ?? null,
        HEART_mean: this._baselineStats.HEART?.mean ?? null,
        HEAD_mean:  this._baselineStats.HEAD?.mean  ?? null,
      } : null,
    });

    this._hugPeakTcs = V?.tcs || 0;
    this._hugPeakLostSince = null;

    this._transition('CLOSING', `${reason}. Closing with ${closingFreq.frequency_hz} Hz (${closingFreq.regime} · ${closingFreq.name})`);
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
