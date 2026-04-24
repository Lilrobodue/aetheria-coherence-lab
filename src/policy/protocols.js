// policy/protocols.js
// Maps an arrival-state classification to a prescription strategy.
// Each protocol is a pure function: (ctx) -> { freq, rationale, ... } | null.
// A null return means "do not prescribe at this tick" (legitimate for
// maintenance, where we defer to the user's own regulation).
//
// Spec references:
//   - coherence_lab_baseline_spec.md §3.3
//   - coherence_lab_targeted_selection_spec.md §3 (regime-targeted pivot/escalation)

import { CLASSIFICATIONS, deficitRegime } from './baseline-classifier.js';

const REGIMES = ['GUT', 'HEART', 'HEAD'];
const GUT_FOUNDATION_ORDER = [174, 285, 396, 528];

// Cross-regime escalation bridge tones (targeted-selection spec §3.3):
// each entry is the root-9 tone that caps a regime and bridges to the next.
const REGIME_BRIDGES = {
  GUT:   { next: 'HEART', bridge: 963 },  // GUT-9 → HEART
  HEART: { next: 'HEAD',  bridge: 3150 }, // HEART-9 → HEAD
  HEAD:  { next: 'GUT',   bridge: 6336 }, // HEAD-9 → back to foundation, or CLOSING
};

/**
 * @typedef {Object} ProtocolCtx
 * @property {string}  classification       From classify() — string label.
 * @property {object}  baseline             Baseline stats (per-regime, spin, deficit_majority, ...).
 * @property {object}  coherence            Current coherence vector.
 * @property {object[]} history             Frequencies already played this session.
 * @property {object[]} library             Full frequencies.json array.
 * @property {object}  spin                 { current, peakSinceBaseline, declining }
 * @property {object}  [gutRolling]         Rolling 30s GUT coherence stats, for foundation gating.
 * @property {string}  [targetRegime]       Cached target regime from state machine.
 * @property {number[]} [targetRegimePeaks] TCS peaks achieved while playing targetRegime.
 */

/**
 * Pick the first frequency from a regime, preferring a given digital root.
 * Returns the pool for logging alongside the single selection.
 */
function pickByRegimeAndRoot(library, regime, root, history, window = 5) {
  const recent = new Set(history.slice(-window).map(f => f.frequency_hz));
  const inRegime = library.filter(f => f.regime === regime);
  const candidatePool = inRegime.filter(f => !recent.has(f.frequency_hz));

  const rootMatch = candidatePool.find(f => f.digital_root === root);
  if (rootMatch) return { freq: rootMatch, candidatePool };

  if (candidatePool.length) return { freq: candidatePool[0], candidatePool };

  const any = inRegime[0] || null;
  return { freq: any, candidatePool: any ? [any] : [] };
}

/** Resolve the regime that protocols should target this session. */
export function resolveTargetRegime(baseline, classification, coherence) {
  if (baseline?.deficit_majority && baseline.deficit_majority !== 'NONE') {
    return baseline.deficit_majority;
  }
  if (coherence?.deficit && coherence.deficit !== 'NONE') {
    return coherence.deficit;
  }
  if (baseline) return deficitRegime(baseline);
  return 'GUT';
}

/**
 * Maintenance: do not intervene while the user is actively self-regulating.
 * Offer a single completion tone when either:
 *   (a) spin has peaked and is declining naturally (preferred), or
 *   (b) a completion timeout has elapsed without a natural spin decline —
 *       prevents the session from feeling empty when spin plateaus (observed
 *       in session Joe-new-solo_2026-04-24; user quit at t=104s).
 * After one completion tone plays, subsequent ticks return null so the normal
 * close-rules (sustained peak / stagnation / time-cap) take over.
 */
export function maintenanceProtocol(ctx) {
  // Only ever offer one completion tone per session.
  if (ctx.history && ctx.history.length > 0) return null;

  const leadRegime = ctx.coherence?.lead || 'HEART';
  const pick = pickByRegimeAndRoot(ctx.library, leadRegime, 9, ctx.history, 0);
  if (!pick.freq) return null;

  const naturalDecline = ctx.spin && ctx.spin.peakSinceBaseline > 0.3 && ctx.spin.declining;
  const timeout = ctx.maintenanceCompletionTimeoutSec ?? 180;
  const timedOut = (ctx.timeSinceBaseline ?? 0) >= timeout;

  if (!naturalDecline && !timedOut) return null;

  const trigger = naturalDecline ? 'spin-decline' : 'timeout';
  return {
    freq: pick.freq,
    rationale: 'closing',
    target_regime: leadRegime,
    target_regime_rationale: naturalDecline
      ? 'lead regime at natural completion (spin decline)'
      : `lead regime at timed completion (${timeout}s)`,
    candidate_pool: pick.candidatePool.map(f => f.frequency_hz),
    selection_rationale: `maintenance — completion tone (${trigger})`,
  };
}

/** Reinforcement: one gentle closing/completion tone in the lead regime. */
export function reinforcementProtocol(ctx) {
  const leadRegime = ctx.coherence?.lead || 'HEART';
  const root = ctx.history.length === 0 ? 9 : 3;
  const pick = pickByRegimeAndRoot(ctx.library, leadRegime, root, ctx.history);
  if (!pick.freq) return null;
  return {
    freq: pick.freq,
    rationale: 'closing',
    target_regime: leadRegime,
    target_regime_rationale: 'lead regime (reinforcement)',
    candidate_pool: pick.candidatePool.map(f => f.frequency_hz),
    selection_rationale: 'reinforcement — gentle closing tone in lead regime',
  };
}

/** Deficit: prescribe only into the target (cached) lagging regime. */
export function deficitProtocol(ctx) {
  const target = ctx.targetRegime || resolveTargetRegime(ctx.baseline, ctx.classification, ctx.coherence);

  if (ctx.baseline && ctx.baseline[target] && ctx.baseline[target].mean > 0.70) {
    // Rare: the cached target was already coherent at baseline. Fall back to
    // deficitRegime of baseline (next lowest).
    const fallback = deficitRegime(ctx.baseline);
    if (fallback === target) return null;
    return deficitProtocol({ ...ctx, targetRegime: fallback });
  }

  // Progressive root walk WITHIN the target regime: first-prescription is
  // root 3 where available (else 9 for HEART), subsequent picks cycle roots
  // to maximize within-regime variety before we ever escalate.
  const historyInRegime = ctx.history.filter(f => f.regime === target);
  const phase = historyInRegime.length % 3;
  const rootCycle = target === 'HEART' ? [9, 9, 9] : [3, 6, 9];
  const preferredRoot = rootCycle[phase];

  const pick = pickByRegimeAndRoot(ctx.library, target, preferredRoot, ctx.history);
  if (!pick.freq) return null;

  const firstInRegime = historyInRegime.length === 0;
  return {
    freq: pick.freq,
    rationale: 'deficit',
    target_regime: target,
    target_regime_rationale: firstInRegime
      ? `baseline deficit_majority=${ctx.baseline?.deficit_majority || 'inferred'}`
      : 'staying within target regime',
    candidate_pool: pick.candidatePool.map(f => f.frequency_hz),
    selection_rationale: firstInRegime
      ? `first-prescription for ${ctx.classification} classification, ${target} deficit`
      : `pivot within ${target} (attempt ${historyInRegime.length + 1}) — root ⌬${preferredRoot}`,
  };
}

/** Foundation: GUT grounding sequence. Do not prescribe HEAD until GUT rolling-30s > 0.5. */
export function foundationProtocol(ctx) {
  const gutCleared = (ctx.gutRolling?.mean ?? 0) > 0.5;
  const played = new Set(ctx.history.map(f => f.frequency_hz));

  if (!gutCleared) {
    for (const hz of GUT_FOUNDATION_ORDER) {
      if (!played.has(hz)) {
        const freq = ctx.library.find(f => f.frequency_hz === hz);
        if (freq) return {
          freq, rationale: 'foundation',
          target_regime: 'GUT',
          target_regime_rationale: 'dysregulated → grounding sequence',
          candidate_pool: GUT_FOUNDATION_ORDER.filter(h => !played.has(h)),
          selection_rationale: `foundation sequence step ${GUT_FOUNDATION_ORDER.indexOf(hz) + 1} of ${GUT_FOUNDATION_ORDER.length}`,
        };
      }
    }
    const pick = pickByRegimeAndRoot(ctx.library, 'GUT', 9, ctx.history);
    if (pick.freq) return {
      freq: pick.freq, rationale: 'foundation',
      target_regime: 'GUT',
      target_regime_rationale: 'grounding continues — foundation sequence exhausted',
      candidate_pool: pick.candidatePool.map(f => f.frequency_hz),
      selection_rationale: 'foundation fallback — GUT root-9',
    };
    return null;
  }

  const lag = ['HEART', 'GUT'].find(r => (ctx.baseline[r]?.mean ?? 0) < 0.70) || 'HEART';
  const pick = pickByRegimeAndRoot(ctx.library, lag, 3, ctx.history);
  if (!pick.freq) return null;
  return {
    freq: pick.freq, rationale: 'deficit',
    target_regime: lag,
    target_regime_rationale: 'GUT cleared — shifting to next lagging regime',
    candidate_pool: pick.candidatePool.map(f => f.frequency_hz),
    selection_rationale: `foundation complete — targeting ${lag}`,
  };
}

/**
 * Cross-regime escalation (targeted-selection spec §3.3).
 * Invoked by the state machine only after exhausting the current target regime
 * (≥N attempts with no peak meeting the ratio threshold).
 * @param {string} fromRegime
 * @param {object} ctx
 * @returns {{freq, rationale, target_regime, ...} | null}
 */
export function selectCrossRegimeEscalation(fromRegime, ctx) {
  const bridgeDef = REGIME_BRIDGES[fromRegime];
  if (!bridgeDef) return null;

  const played = new Set(ctx.history.map(f => f.frequency_hz));

  // If HEAD is exhausted and no peak materialized, we prefer CLOSING over a
  // GUT fallback. The state machine handles the decision to enter CLOSING
  // directly; here we simply signal "no escalation target" so the caller can
  // route to closing.
  if (fromRegime === 'HEAD') return null;

  // Prefer the bridge tone (from-regime's root-9) if it hasn't played yet.
  if (!played.has(bridgeDef.bridge)) {
    const bridgeFreq = ctx.library.find(f => f.frequency_hz === bridgeDef.bridge);
    if (bridgeFreq) {
      return {
        freq: bridgeFreq,
        rationale: 'deficit',
        target_regime: fromRegime,
        next_regime: bridgeDef.next,
        target_regime_rationale: `bridging ${fromRegime} → ${bridgeDef.next}`,
        candidate_pool: [bridgeDef.bridge],
        selection_rationale: `cross-regime escalation: ${fromRegime}-9 (${bridgeDef.bridge} Hz) bridge before ${bridgeDef.next}`,
      };
    }
  }

  // Bridge already played — escalate straight into the next regime.
  const pick = pickByRegimeAndRoot(ctx.library, bridgeDef.next, 3, ctx.history);
  if (!pick.freq) return null;
  return {
    freq: pick.freq,
    rationale: 'deficit',
    target_regime: bridgeDef.next,
    target_regime_rationale: `${fromRegime} exhausted — escalating to ${bridgeDef.next}`,
    candidate_pool: pick.candidatePool.map(f => f.frequency_hz),
    selection_rationale: `cross-regime escalation into ${bridgeDef.next}`,
  };
}

/**
 * Deficit-aware closing bridge (targeted-selection spec §4.5).
 *   - If the deficit was addressed (coherence improved meaningfully over
 *     baseline in the target regime), close on target-regime root-9 (integration).
 *   - If the deficit was fresh and never really engaged, close on first-order
 *     target-regime tone (re-entry).
 *   - Otherwise fall back to lead-regime root-9.
 *
 * @returns {object|null}  a frequency entry or null
 */
export function selectClosingBridge({ library, baseline, liveCoherence, targetRegime, history }) {
  const fallbackLead = liveCoherence?.lead || 'HEART';

  if (!targetRegime || !baseline) {
    const hz = fallbackLead === 'HEAD' ? 6336 : (fallbackLead === 'HEART' ? 3150 : 963);
    return library.find(f => f.frequency_hz === hz) || null;
  }

  const baselineMean = baseline[targetRegime]?.mean ?? 0;
  const liveRegimeKey = targetRegime.toLowerCase();
  const liveMean = liveCoherence?.[liveRegimeKey] ?? 0;

  const inRegime = library.filter(f => f.regime === targetRegime);
  // Terminal root-9 = highest-order root-9 tone in the regime
  // (HEART → 3150, GUT → 963, HEAD → 6336).
  const root9Sorted = inRegime
    .filter(f => f.digital_root === 9)
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || b.frequency_hz - a.frequency_hz);
  const terminalRoot9 = root9Sorted[0] || null;

  // Deficit engaged and improved: close at terminal root-9 (integration).
  if (liveMean > baselineMean + 0.10 && terminalRoot9) {
    return terminalRoot9;
  }

  // Deficit never really engaged — close on first-order target tone (re-entry).
  const played = new Set(history.map(f => f.frequency_hz));
  const byOrder = inRegime.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.frequency_hz - b.frequency_hz);
  const fresh = byOrder.find(f => !played.has(f.frequency_hz));
  if (fresh) return fresh;

  // Otherwise the terminal root-9 tone.
  return terminalRoot9 || inRegime[0] || null;
}

const PROTOCOL_BY_CLASSIFICATION = {
  [CLASSIFICATIONS.REGULATED_ACTIVE]: maintenanceProtocol,
  [CLASSIFICATIONS.REGULATED_STABLE]: reinforcementProtocol,
  [CLASSIFICATIONS.MIXED]:            deficitProtocol,
  [CLASSIFICATIONS.DYSREGULATED]:     foundationProtocol,
};

/**
 * Dispatch to the protocol that matches a classification.
 * @param {ProtocolCtx} ctx
 * @returns {{freq:object, rationale:string, ...}|null}
 */
export function runProtocol(ctx) {
  const fn = PROTOCOL_BY_CLASSIFICATION[ctx.classification];
  if (!fn) return null;
  return fn(ctx);
}
