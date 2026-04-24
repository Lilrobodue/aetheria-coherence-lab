// bcs/phase-transition.js
// Detects sustained BCS phase transitions from Doc 5 §5.
//
// Replaced 2026-04-24 (after 12-session PT audit): the previous implementation
// scanned a rolling 200-sample BCS history for any 15+ point jump. Once a
// qualifying jump landed in the window it stayed "detected" for ~33 minutes —
// so a BCS that briefly spiked then oscillated wildly (drops of 25-31 points,
// seen in the April 24 session) reported "phase transition" for most of the
// session even though the state clearly wasn't sustained.
//
// New semantics: a phase transition is a STATE, not an EVENT. The user is in
// a phase transition when BCS is sustained above PT_FIRE_THRESHOLD. They
// leave it when BCS is sustained below PT_CLEAR_THRESHOLD. The 10-point
// hysteresis band prevents flag-flapping near the boundary; the consecutive-
// count requirements filter out single-tick spikes and dips.
//
// Asymmetry is intentional: fire on 2 ticks (~20s), clear on 3 ticks (~30s).
// We detect eagerly and clear reluctantly — biased toward "once you're in
// transition, stay in unless it's really gone."
//
// Legacy `detectPhaseTransition(bcsHistory)` kept for callers that haven't
// migrated, but new code should use PhaseTransitionDetector.

// Configuration constants — tunable at the top of the file.
export const PT_FIRE_THRESHOLD  = 60;  // BCS must exceed this to START a phase transition
export const PT_CLEAR_THRESHOLD = 50;  // BCS must drop below this to END a phase transition
export const PT_FIRE_COUNT      = 2;   // consecutive ticks above FIRE to activate  (~20s at 0.1 Hz)
export const PT_CLEAR_COUNT     = 3;   // consecutive ticks below CLEAR to deactivate (~30s)

/**
 * Stateful per-session phase-transition tracker. Call `update(bcs, timeSec)`
 * every BCS tick. `null` values (no measurement) are ignored — they don't
 * progress or reset the consecutive counters.
 *
 * Returned state on each update:
 *   active          — currently in a phase transition?
 *   justFired       — did this call fire PT?
 *   justCleared     — did this call clear PT?
 *   window          — 1-indexed count of PT windows opened this session
 *   durationTicks   — how many ticks since this PT window opened (0 while inactive)
 *   fireTime        — timestamp of the most recent firing (null if never)
 *   clearTime       — timestamp of the most recent clearing (null if never)
 */
export class PhaseTransitionDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this._active = false;
    this._consecutiveAbove = 0;
    this._consecutiveBelow = 0;
    this._window = 0;         // how many PT windows have fired this session
    this._durationTicks = 0;  // ticks since current window opened
    this._fireTime = null;
    this._clearTime = null;
  }

  get active() { return this._active; }
  get window() { return this._window; }

  /**
   * @param {number|null} bcs  current BCS value; null means "no measurement this tick"
   * @param {number} [timeSec] timestamp for recording fire/clear moments
   * @returns {{active:boolean, justFired:boolean, justCleared:boolean, window:number,
   *            durationTicks:number, fireTime:(number|null), clearTime:(number|null)}}
   */
  update(bcs, timeSec = null) {
    let justFired = false;
    let justCleared = false;

    if (bcs == null || !isFinite(bcs)) {
      // No measurement: don't progress or reset counters; advance duration if active.
      if (this._active) this._durationTicks++;
      return this._snapshot(justFired, justCleared);
    }

    if (!this._active) {
      if (bcs >= PT_FIRE_THRESHOLD) {
        this._consecutiveAbove++;
        this._consecutiveBelow = 0;
        if (this._consecutiveAbove >= PT_FIRE_COUNT) {
          this._active = true;
          this._window++;
          this._durationTicks = 1;
          this._consecutiveAbove = 0;
          this._fireTime = timeSec;
          justFired = true;
        }
      } else {
        this._consecutiveAbove = 0;
      }
    } else {
      this._durationTicks++;
      if (bcs < PT_CLEAR_THRESHOLD) {
        this._consecutiveBelow++;
        this._consecutiveAbove = 0;
        if (this._consecutiveBelow >= PT_CLEAR_COUNT) {
          this._active = false;
          this._consecutiveBelow = 0;
          this._clearTime = timeSec;
          justCleared = true;
        }
      } else {
        this._consecutiveBelow = 0;
      }
    }

    return this._snapshot(justFired, justCleared);
  }

  _snapshot(justFired, justCleared) {
    return {
      active: this._active,
      justFired,
      justCleared,
      window: this._window,
      durationTicks: this._active ? this._durationTicks : 0,
      fireTime: this._fireTime,
      clearTime: this._clearTime,
    };
  }
}

/**
 * Legacy stateless jump detector. Kept for backward compatibility with any
 * external callers. New code should use PhaseTransitionDetector. This scans
 * `bcsHistory` for a 15+ point jump in a 60-second window.
 *
 * @param {object[]} bcsHistory - array of { time: number, bcs: number }
 * @returns {{ detected: boolean, time: number|null, magnitude: number|null }}
 */
export function detectPhaseTransition(bcsHistory) {
  if (bcsHistory.length < 10) return { detected: false, time: null, magnitude: null };

  const threshold = 15;
  const windowSec = 60;

  let maxJump = 0;
  let jumpTime = null;

  for (let i = 0; i < bcsHistory.length; i++) {
    for (let j = i + 1; j < bcsHistory.length; j++) {
      const dt = bcsHistory[j].time - bcsHistory[i].time;
      if (dt > windowSec) break;
      const jump = bcsHistory[j].bcs - bcsHistory[i].bcs;
      if (jump > maxJump) {
        maxJump = jump;
        jumpTime = bcsHistory[j].time;
      }
    }
  }

  return {
    detected: maxJump >= threshold,
    time: jumpTime,
    magnitude: +maxJump.toFixed(1)
  };
}
