// math/digital-root.js
// The 3-6-9 digital root reduction from the Unified Lewis Framework.

/**
 * Compute the digital root of a positive integer.
 * Repeatedly sums digits until a single digit remains.
 * @param {number} n - positive integer
 * @returns {number} digital root (1-9)
 */
export function digitalRoot(n) {
  n = Math.abs(Math.floor(n));
  if (n === 0) return 0;
  return 1 + ((n - 1) % 9);
}

/**
 * Check if a digital root belongs to the 3-6-9 family.
 */
export function is369(n) {
  const dr = digitalRoot(n);
  return dr === 3 || dr === 6 || dr === 9;
}

/**
 * Check if a frequency ratio is harmonic (per Doc 2 §5.4).
 * A ratio is harmonic if it's within ±5% of an integer or simple fraction,
 * AND the integers involved reduce to digital roots ∈ {3, 6, 9}.
 *
 * @param {number} ratio - max(f1,f2) / min(f1,f2)
 * @returns {boolean}
 */
export function isHarmonicRatio(ratio) {
  const tolerance = 0.05;
  const targets = [1, 1.5, 2, 3, 4/3, 3/2, 4, 6, 9];

  for (const target of targets) {
    if (Math.abs(ratio - target) / target < tolerance) {
      // Check if the numerator and denominator have 3-6-9 digital roots
      const num = Math.round(target * 6); // scale to integer
      const den = 6;
      if (is369(num) || is369(den) || is369(Math.round(ratio))) {
        return true;
      }
    }
  }
  return false;
}
