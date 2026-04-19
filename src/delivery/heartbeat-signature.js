// delivery/heartbeat-signature.js
// The closing heartbeat end-signature from Doc 3 §2.7.
//
// Three cycles of LUB-dub, slowing and softening:
//   Cycle 1: LUB (140ms) . dub (100ms) — interval ~0.9s, 100% amplitude
//   Cycle 2: LUB . dub — interval ~1.1s, 75% amplitude
//   Cycle 3: LUB . dub — interval ~1.4s, 50% amplitude → silence
//
// Delivered through the Woojer as a felt heartbeat in the chest.
// The fundamental is 64 Hz / ~51 Hz (dub) — Woojer's strong haptic band.
// Each pulse uses a Tukey envelope (half-cosine rise + flat hold +
// half-cosine fall) — the flat hold gives the original method's
// percussive felt strength, and the curved edges give the pi envelope's
// smoothness (no click harmonics in the headphone passthrough). Requires
// DeliveryCoordinator.playHeartbeat() to have faded the closing-frequency
// carriers out first so the pulse plays against silence.

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

  const cycles = [
    { lubDuration: 0.14, dubDuration: 0.10, dubDelay: 0.20, interval: 0.9, amplitude: 1.0 },
    { lubDuration: 0.14, dubDuration: 0.10, dubDelay: 0.20, interval: 1.1, amplitude: 0.75 },
    { lubDuration: 0.14, dubDuration: 0.10, dubDelay: 0.20, interval: 1.4, amplitude: 0.50 },
  ];

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
