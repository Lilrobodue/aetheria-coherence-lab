// bcs/phase-transition.js
// Detects phase transition events in BCS history from Doc 5 §5.
//
// The Unified Lewis Framework predicts that when a session successfully
// entrains the biofield, BCS should JUMP rather than climb smoothly —
// a moment where the three regimes suddenly lock into one mode.
//
// A transition is defined as a 15+ point jump within any 60-second window.

/**
 * Detect phase transition events in BCS history.
 *
 * @param {object[]} bcsHistory - array of { time: number, bcs: number }
 * @returns {{ detected: boolean, time: number|null, magnitude: number|null }}
 */
export function detectPhaseTransition(bcsHistory) {
  if (bcsHistory.length < 10) return { detected: false, time: null, magnitude: null };

  const threshold = 15; // minimum jump to qualify as phase transition
  const windowSec = 60;

  let maxJump = 0;
  let jumpTime = null;

  for (let i = 0; i < bcsHistory.length; i++) {
    // Look forward within a 60-second window
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
