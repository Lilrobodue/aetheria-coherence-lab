// delivery/heartbeat-signature.js
// The closing heartbeat end-signature from Doc 3 §2.7.
//
// Three cycles of LUB-dub, slowing and softening via π-based ratios:
//   Cycle 1: LUB (140ms) . dub (100ms) — interval 1.000s      , amplitude 1.000
//   Cycle 2: LUB . dub                  — interval π/e  ≈1.156s, amplitude 1/√π ≈0.564
//   Cycle 3: LUB . dub                  — interval (π/e)² ≈1.337s, amplitude 1/π  ≈0.318 → silence
//
// The inter-cycle expansion factor is π/e — the natural transcendental
// "slightly bigger than 1" constant, giving an organic slowdown. Amplitude
// decays by 1/√π per step (half-steps of 1/π), a clean math-derived fade.
// LUB-dub INTRA-cycle timing stays fixed — that's the physiological
// fingerprint of a real heartbeat and changing it makes the signature feel
// wrong.
//
// Delivered through the Woojer as a felt heartbeat in the chest.
// The fundamental is 64 Hz / ~51 Hz (dub) — Woojer's strong haptic band.
// Each pulse uses a Tukey envelope (half-cosine rise + flat hold +
// half-cosine fall) — the flat hold gives the original method's
// percussive felt strength, and the curved edges give the pi envelope's
// smoothness (no click harmonics in the headphone passthrough). Requires
// DeliveryCoordinator.playHeartbeat() to have faded the closing-frequency
// carriers out first so the pulse plays against silence.

// π-derived constants used throughout the signature.
export const PI_OVER_E = Math.PI / Math.E;          // ≈1.1557
export const ONE_OVER_SQRT_PI = 1 / Math.sqrt(Math.PI); // ≈0.5642
export const ONE_OVER_PI = 1 / Math.PI;             // ≈0.3183

/**
 * Generate the three π-timed cycle specs (interval + amplitude).
 * Exposed for tests and for anyone who wants to tune on top of it.
 * @param {number} [baseInterval=1.0] base interval for cycle 1 in seconds
 * @returns {Array<{interval:number, amplitude:number}>}
 */
export function piTimedCycles(baseInterval = 1.0) {
  return [
    { interval: baseInterval,                       amplitude: 1.0 },
    { interval: baseInterval * PI_OVER_E,            amplitude: ONE_OVER_SQRT_PI },
    { interval: baseInterval * PI_OVER_E * PI_OVER_E, amplitude: ONE_OVER_PI },
  ];
}

/**
 * Play the heartbeat end-signature through the Woojer.
 * Returns a promise that resolves when the signature completes (~4s).
 *
 * @param {AudioContext} ctx - Web Audio context
 * @param {AudioNode} destination - output node (master gain → speakers + Woojer)
 * @param {number} [baseFreqHz=64] - base frequency for the heartbeat pulse.
 *   Sits in the Woojer's strong haptic band for a firm chest thump
 *   that can be felt through clothing.
 * @param {number} [strength=1.0] - multiplier on cycle amplitude. The default
 *   1.0 produces a 0.55-peak bell. Values above ~1.7 hit the 0.95 clamp
 *   in _pulse() (safety net against DAC clipping) and stop scaling.
 * @returns {Promise<void>}
 */
export async function playHeartbeatSignature(ctx, destination, baseFreqHz = 64, strength = 1.0) {
  if (ctx.state === 'suspended') await ctx.resume();

  const piCycles = piTimedCycles(1.0);
  const cycles = piCycles.map(c => ({
    lubDuration: 0.14,  // fixed — physiological LUB-dub fingerprint
    dubDuration: 0.10,
    dubDelay:    0.20,
    interval:    c.interval,
    amplitude:   c.amplitude,
  }));

  let t = ctx.currentTime + 0.05; // small lead-in

  for (const cycle of cycles) {
    const scaledAmp = cycle.amplitude * strength;
    // LUB — stronger systolic pulse
    _pulse(ctx, destination, t, cycle.lubDuration, baseFreqHz, scaledAmp);

    // dub — softer diastolic pulse
    _pulse(ctx, destination, t + cycle.dubDelay, cycle.dubDuration, baseFreqHz * 0.8, scaledAmp * 0.6);

    t += cycle.interval;
  }

  // Wait for the full signature to complete
  const totalDuration = (t - ctx.currentTime) + 0.5;
  await new Promise(r => setTimeout(r, totalDuration * 1000));
}

/** Create a single haptic pulse. */
function _pulse(ctx, destination, startTime, duration, freqHz, amplitude) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freqHz;

  // Peak is amplitude * 0.4 baseline. Clamp at 0.95 so boosted strengths
  // (>2.5×) can't drive the gain node into clipping territory at the DAC.
  const peak = Math.min(amplitude * 0.55, 0.95);
  const gain = ctx.createGain();
  // Tukey envelope — half-cosine rise, flat peak hold, half-cosine fall.
  // The 60% flat hold gives the original trapezoidal method's strong
  // sustained drive into the Woojer's voice coil; the 20% cosine tapers
  // on each end have zero slope at the endpoints so there are no sharp
  // corners to produce click harmonics. Strength of the original +
  // smoothness of the pi envelope.
  const N = 128;
  const curve = new Float32Array(N);
  const riseFrac = 0.2;
  const fallFrac = 0.2;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    let g;
    if (t < riseFrac) {
      g = (1 - Math.cos(Math.PI * t / riseFrac)) / 2;
    } else if (t < 1 - fallFrac) {
      g = 1;
    } else {
      const x = (t - (1 - fallFrac)) / fallFrac;
      g = (1 + Math.cos(Math.PI * x)) / 2;
    }
    curve[i] = peak * g;
  }
  gain.gain.setValueCurveAtTime(curve, startTime, duration);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.01);
}
