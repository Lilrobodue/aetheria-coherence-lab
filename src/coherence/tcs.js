// coherence/tcs.js
// Triune Coherence Score from Doc 2 §6.
// Single composite 0-100 that the prescription engine reads each second.
//
// When one or more regimes are offline (sensor stale, insufficient data),
// the available terms are renormalised so TCS still spans 0-100 and the
// returned `confidence` tells downstream consumers what fraction of the
// full weight set contributed to the score.
//
// Default weights (sum = 1.0):
//   gut 0.20 · heart 0.20 · head 0.20 · triunePLV 0.25 · harmonicLock 0.15

const DEFAULT_WEIGHTS = {
  gut:          0.20,
  heart:        0.20,
  head:         0.20,
  triunePLV:    0.25,
  harmonicLock: 0.15,
};

// Maps value-object keys to weight-object keys (which may use underscores
// in user-supplied config files).
const TERM_MAP = [
  ['gut',          'gut'],
  ['heart',        'heart'],
  ['head',         'head'],
  ['triunePLV',    'triunePLV'],
  ['harmonicLock', 'harmonicLock'],
];

/**
 * Compute the Triune Coherence Score with dynamic reweighting.
 *
 * @param {object} values - { gut, heart, head, triunePLV, harmonicLock }
 *        Each value is a number in [0,1] or null/undefined when that term
 *        is unavailable (sensor offline, insufficient data).
 * @param {object} [weights] - optional weight overrides (same keys as DEFAULT_WEIGHTS,
 *        or legacy underscore form: triune_plv / harmonic_lock)
 * @returns {{ tcs: number, confidence: number }}
 */
export function computeTCS(values, weights) {
  const w = normaliseWeightKeys(weights || DEFAULT_WEIGHTS);

  let availableWeight = 0;
  let weightedSum = 0;

  for (const [valKey, wKey] of TERM_MAP) {
    const v = values[valKey];
    if (v !== null && v !== undefined && isFinite(v)) {
      const termWeight = w[wKey] ?? DEFAULT_WEIGHTS[wKey];
      availableWeight += termWeight;
      weightedSum += termWeight * v;
    }
  }

  if (availableWeight === 0) return { tcs: 0, confidence: 0 };

  // Renormalise so the score still spans 0-100
  const tcs = 100 * weightedSum / availableWeight;

  // Confidence = fraction of the full weight budget that was present
  const totalWeight = TERM_MAP.reduce((s, [, wKey]) => s + (w[wKey] ?? DEFAULT_WEIGHTS[wKey]), 0);
  const confidence = availableWeight / totalWeight;

  return { tcs, confidence };
}

/** Accept either camelCase or underscore keys from config files. */
function normaliseWeightKeys(raw) {
  const out = { ...raw };
  if (raw.triune_plv !== undefined && out.triunePLV === undefined) {
    out.triunePLV = raw.triune_plv;
  }
  if (raw.harmonic_lock !== undefined && out.harmonicLock === undefined) {
    out.harmonicLock = raw.harmonic_lock;
  }
  return out;
}
