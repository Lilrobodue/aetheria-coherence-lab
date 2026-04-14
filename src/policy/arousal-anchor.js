// policy/arousal-anchor.js  (v1.2)
// Session-anchored arousal index and cascade direction from Doc 3 §3.1.
//
// The cascade direction (ASCENDING 3→6→9 or DESCENDING 9→6→3) is personal,
// anchored to THIS user's baseline on THIS day. Direction can flip mid-session
// when the user's arousal drifts past the flip margin.
//
// v1.2 changes (session 2):
//   - updateDrift() called every second during ENTRAIN (was only at PIVOT).
//   - Flip margin tightened from 0.15 to 0.10.
//   - Sustained-drift requirement: 15 consecutive seconds above threshold
//     before a flip queues.
//   - consumePendingFlip() clears drift history to prevent re-flipping.
//   - Graceful null handling: arousal computed from heart alone when head
//     is offline, rather than returning 0.

import { sigmoid } from '../math/stats.js';

const DEFAULT_FLIP_MARGIN = 0.10;         // v1.2: tightened from 0.15
const SUSTAIN_REQUIRED_SEC = 15;          // consecutive seconds of drift
const DRIFT_HISTORY_WINDOW_SEC = 30;      // rolling window

export class ArousalAnchor {
  constructor(flipMargin = DEFAULT_FLIP_MARGIN) {
    this._flipMargin = flipMargin;
    this._anchor = null;
    this._direction = null; // 'ASCENDING' or 'DESCENDING'
    this._pendingFlip = null;

    // v1.2: rolling drift history for sustained-drift detection
    this._driftHistory = [];  // { timestamp, drift, proposedDirection }
  }

  get anchor() { return this._anchor; }
  get direction() { return this._direction; }
  get pendingFlip() { return this._pendingFlip; }
  get calibrated() { return this._anchor !== null; }

  /**
   * Set the session anchor from baseline features (Doc 3 §3.1).
   * Called at the end of BASELINE state.
   *
   * @returns {{ initialDirection: string }}
   */
  setAnchor(baselineFeatures) {
    const heart = baselineFeatures.heart;
    const head = baselineFeatures.head;

    this._anchor = this._computeArousal(heart, head);

    // Initial direction based on anchor
    if (this._anchor > 0) {
      this._direction = 'DESCENDING'; // overcharged → settle down
    } else {
      this._direction = 'ASCENDING';  // depleted → build up
    }

    this._pendingFlip = null;
    this._driftHistory = [];

    return { initialDirection: this._direction };
  }

  /**
   * v1.2: Update drift every second during ENTRAIN.
   * Computes the live arousal index, appends to a 30-second rolling drift
   * history, and checks whether drift has sustained beyond the threshold
   * in the same direction for 15 consecutive seconds.
   *
   * @param {object} currentFeatures - latest features from the feature engine
   * @param {number} timestamp - seconds (performance.now() / 1000)
   */
  updateDrift(currentFeatures, timestamp) {
    if (this._anchor === null) return;

    const heart = currentFeatures.heart;
    const head = currentFeatures.head;

    const currentArousal = this._computeArousal(heart, head);
    const drift = currentArousal - this._anchor;

    // What direction would this drift suggest?
    let proposedDirection = null;
    if (drift > this._flipMargin && this._direction !== 'DESCENDING') {
      proposedDirection = 'DESCENDING';
    } else if (drift < -this._flipMargin && this._direction !== 'ASCENDING') {
      proposedDirection = 'ASCENDING';
    }

    // Append to rolling history
    this._driftHistory.push({ timestamp, drift, proposedDirection });

    // Trim to window
    const cutoff = timestamp - DRIFT_HISTORY_WINDOW_SEC;
    while (this._driftHistory.length > 0 && this._driftHistory[0].timestamp < cutoff) {
      this._driftHistory.shift();
    }

    // Check sustained drift: last SUSTAIN_REQUIRED_SEC entries must all
    // propose the same flip direction.
    this._pendingFlip = this._checkSustainedFlip(timestamp);
  }

  /**
   * v1.2: Consume and apply a pending flip (called from state machine at
   * decision points). If a flip has been queued, it is applied, the drift
   * history is cleared (so the next flip requires fresh sustained drift),
   * and the new direction is returned.
   *
   * @returns {string|null} new direction if a flip was applied, else null
   */
  consumePendingFlip() {
    if (!this._pendingFlip) return null;

    const newDirection = this._pendingFlip;
    this._direction = newDirection;
    this._pendingFlip = null;
    this._driftHistory = []; // prevent immediate re-flip on same data

    return newDirection;
  }

  // ---- v1.1 compatibility: used by state machine during ENTRAIN ----

  /**
   * Legacy single-shot drift computation. Still works but the sustained-
   * drift path in updateDrift + consumePendingFlip is preferred in v1.2.
   */
  computeDrift(currentFeatures) {
    if (this._anchor === null) return { drift: 0, shouldFlip: null };

    const heart = currentFeatures.heart;
    const head = currentFeatures.head;

    const currentArousal = this._computeArousal(heart, head);
    const drift = currentArousal - this._anchor;

    return { drift, shouldFlip: this._pendingFlip };
  }

  /** Legacy: apply a pending flip (v1.1 API, still works). */
  applyFlip() {
    const result = this.consumePendingFlip();
    return result !== null;
  }

  // ---- Internal ----

  _checkSustainedFlip(now) {
    // Look at the last SUSTAIN_REQUIRED_SEC entries
    const windowStart = now - SUSTAIN_REQUIRED_SEC;
    const recent = this._driftHistory.filter(d => d.timestamp >= windowStart);

    // Need at least SUSTAIN_REQUIRED_SEC entries (1 per second)
    if (recent.length < SUSTAIN_REQUIRED_SEC) return null;

    // All must propose the same non-null direction
    const firstDir = recent[0].proposedDirection;
    if (!firstDir) return null;

    for (const entry of recent) {
      if (entry.proposedDirection !== firstDir) return null;
    }

    return firstDir;
  }

  /**
   * Compute arousal index from heart and/or head features.
   * v1.2: handles missing head features gracefully — computes from heart
   * terms alone when head is offline, scaled to the same range.
   */
  _computeArousal(heart, head) {
    if (!heart && !head) return 0;

    // Sympathetic indicators (push arousal up)
    let sympathetic = 0;
    let parasympathetic = 0;
    let termCount = 0;

    if (heart) {
      sympathetic += sigmoid((heart.lfHfRatio || 1) - 1);
      parasympathetic += sigmoid((heart.hfNorm || 0.3) * 3 - 1);
      termCount += 2;
    }

    if (head) {
      sympathetic += sigmoid((head.betaPower || 0.2) * 5 - 1);
      parasympathetic += sigmoid((head.alphaPowerNorm || 0.2) * 5 - 1);
      termCount += 2;
    }

    // Normalise so the index has the same scale regardless of how many
    // terms contributed. With all 4 terms, each contributes ~0.25 of the
    // range; with 2 terms, each contributes ~0.5.
    if (termCount === 0) return 0;
    return (sympathetic - parasympathetic) * (4 / termCount);
  }
}
