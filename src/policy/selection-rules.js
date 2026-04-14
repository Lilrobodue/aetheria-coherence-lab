// policy/selection-rules.js  (v1.2)
// Frequency selection logic from Doc 3 §3.
// Chooses the next frequency based on the coherence vector, cascade direction,
// and the Seed/Bloom frequency architecture.
//
// v1.2 changes (session 2):
//   - CascadeCursor: session-scoped object tracking position in the root
//     cycle so PIVOT and ADVANCE both advance the cursor continuously.
//   - Direction flips reset the cursor to position 0.
//   - No-repetition window of 5 preserved with three-tier fallback.

// --- Cascade order ---
const CASCADE_ORDER = {
  ASCENDING:  [3, 6, 9],
  DESCENDING: [9, 6, 3],
};

/**
 * Session-scoped cursor tracking position within the 3-6-9 root cycle.
 * Both ADVANCE and PIVOT advance the cursor by one step so the root
 * progression is continuous regardless of the selection reason.
 */
export class CascadeCursor {
  constructor() {
    this._direction = 'DESCENDING';
    this._position = 0; // index into CASCADE_ORDER[direction]
  }

  get direction() { return this._direction; }
  get position() { return this._position; }

  /** Reset the cursor to a direction at position 0. */
  reset(direction) {
    this._direction = direction;
    this._position = 0;
  }

  /** Return the current digital root without advancing. */
  peek() {
    const order = CASCADE_ORDER[this._direction];
    return order[this._position % order.length];
  }

  /** Return the current digital root and advance the cursor by one step. */
  next() {
    const order = CASCADE_ORDER[this._direction];
    const root = order[this._position % order.length];
    this._position = (this._position + 1) % order.length;
    return root;
  }

  /** Flip direction and reset to position 0 (called on cascade flip). */
  flipTo(newDirection) {
    this._direction = newDirection;
    this._position = 0;
  }
}

/**
 * Apply a direction flip to the cursor.
 * @param {string} newDirection - 'ASCENDING' or 'DESCENDING'
 * @param {CascadeCursor} cursor
 */
export function onDirectionFlip(newDirection, cursor) {
  cursor.flipTo(newDirection);
}

/**
 * Select the first frequency after BASELINE (Doc 3 §3.2).
 *
 * @param {object} coherenceVector - from CoherenceEngine
 * @param {object[]} library - frequencies.json array
 * @param {CascadeCursor} cursor
 * @returns {object} selected frequency entry
 */
export function selectFirstFrequency(coherenceVector, library, cursor) {
  const deficit = coherenceVector.deficit || 'NONE';

  // Pick the target regime
  let regime;
  if (deficit !== 'NONE') {
    regime = deficit;
  } else {
    regime = 'GUT'; // default: start with foundation
  }

  const root = cursor.next();
  return pickInRegime(regime, library, root, null, []);
}

/**
 * Select the next frequency after EVALUATE (Doc 3 §3.3).
 * Both ADVANCE and PIVOT advance the cursor — the only difference is
 * which regime the new frequency comes from.
 *
 * @param {string} hint - 'HOLD' | 'ADVANCE' | 'PIVOT'
 * @param {object} currentFreq - currently playing frequency entry
 * @param {object} coherenceVector - current coherence state
 * @param {object[]} library - frequencies.json array
 * @param {object[]} history - last N played frequencies
 * @param {CascadeCursor} cursor
 * @returns {object|null} next frequency, or currentFreq for HOLD
 */
export function selectNextFrequency(hint, currentFreq, coherenceVector, library, history, cursor) {
  if (hint === 'HOLD') return currentFreq;

  // Both ADVANCE and PIVOT advance the cursor
  const root = cursor.next();

  if (hint === 'ADVANCE') {
    return selectAdvance(currentFreq, library, history, root, cursor.direction);
  }

  if (hint === 'PIVOT') {
    return selectPivot(coherenceVector, library, history, root);
  }

  return currentFreq; // fallback
}

/**
 * ADVANCE: stay in the same regime, walk the root cycle,
 * and climb octave orders within HEAD (Doc 3 §3.3).
 */
function selectAdvance(currentFreq, library, history, root, direction) {
  const regime = currentFreq.regime;
  const order = currentFreq.order;

  const sameRegime = library.filter(f => f.regime === regime);
  const sameOrder = sameRegime.filter(f => f.order === order);

  // Try the cursor's root within the same order
  let pick = findUnplayed(sameOrder, root, history);
  if (pick) return pick;

  // Octave climbing within HEAD: try the next order with the cursor root
  if (regime === 'HEAD') {
    const nextOrder = direction === 'ASCENDING' ? order + 1 : order - 1;
    const nextOrderFreqs = sameRegime.filter(f => f.order === nextOrder);
    pick = findUnplayed(nextOrderFreqs, root, history);
    if (pick) return pick;
  }

  // Cross regime boundary: GUT→HEART→HEAD (ascending) or reverse
  const regimeOrder = ['GUT', 'HEART', 'HEAD'];
  const regimeIdx = regimeOrder.indexOf(regime);
  const nextRegimeIdx = direction === 'ASCENDING' ? regimeIdx + 1 : regimeIdx - 1;

  if (nextRegimeIdx >= 0 && nextRegimeIdx < regimeOrder.length) {
    const nextRegime = regimeOrder[nextRegimeIdx];
    return pickInRegime(nextRegime, library, root, null, history);
  }

  // At the top/bottom of the entire system — stay where we are
  return currentFreq;
}

/**
 * PIVOT: switch to the deficit regime (Doc 3 §3.3).
 * Uses the cursor root (not the regime's default root).
 */
function selectPivot(coherenceVector, library, history, root) {
  const deficit = coherenceVector.deficit;

  if (!deficit || deficit === 'NONE') {
    // No clear deficit — pick the regime with the lowest score
    const scores = [
      { regime: 'GUT',   value: coherenceVector.gut ?? 0 },
      { regime: 'HEART', value: coherenceVector.heart ?? 0 },
      { regime: 'HEAD',  value: coherenceVector.head ?? 0 },
    ];
    scores.sort((a, b) => a.value - b.value);
    return pickInRegime(scores[0].regime, library, root, null, history);
  }

  return pickInRegime(deficit, library, root, null, history);
}

/**
 * Pick a frequency within a regime, preferring the given digital root.
 * Three-tier fallback: exact match → same regime+root → same regime.
 */
function pickInRegime(regime, library, preferRoot, preferOrder, history) {
  const inRegime = library.filter(f => f.regime === regime);
  if (inRegime.length === 0) return library[0]; // shouldn't happen

  // Determine target order
  let targetOrder = preferOrder;
  if (!targetOrder) {
    const orders = [...new Set(inRegime.map(f => f.order))].sort((a, b) => a - b);
    // Pick the middle order (balanced starting point)
    targetOrder = orders[Math.floor(orders.length / 2)];
  }

  const orderFreqs = inRegime.filter(f => f.order === targetOrder);

  // Tier 1: exact match (regime + order + root), not recently played
  let pick = findUnplayed(orderFreqs, preferRoot, history);
  if (pick) return pick;

  // Tier 2: same regime + root, any order
  const rootFreqs = inRegime.filter(f => f.digital_root === preferRoot);
  pick = rootFreqs.find(f => !isRecent(f, history));
  if (pick) return pick;

  // Tier 3: same regime, any root, not recently played
  pick = inRegime.find(f => !isRecent(f, history));
  if (pick) return pick;

  // Last resort: just pick something in the regime
  return orderFreqs[0] || inRegime[0];
}

/**
 * Find an unplayed frequency matching the target root within a set.
 */
function findUnplayed(freqs, root, history) {
  const match = freqs.find(f => f.digital_root === root && !isRecent(f, history));
  if (match) return match;
  // If the exact root was recently played, try any in the set
  return freqs.find(f => !isRecent(f, history)) || null;
}

function isRecent(freq, history, window = 5) {
  const recent = history.slice(-window);
  return recent.some(h => h.frequency_hz === freq.frequency_hz);
}
