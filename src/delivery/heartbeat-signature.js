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
// Each pulse uses a pi-envelope (half-sine bell, sin(π·t/duration)) so
// the waveform rises and falls with no sharp edges. In isolation this
// pulse is effectively silent through studio headphones but felt firmly
// in the chest — provided the closing-frequency carriers have been faded
// out first, which DeliveryCoordinator.playHeartbeat() does before
// invoking this function.

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
  // Pi envelope — half-sine bell: gain(t) = peak · sin(π · t/duration).
  // Rises from 0 to peak at midpoint, falls back to 0 at end. No sharp
  // edges, so zero click harmonics in the headphone passthrough, but the
  // Woojer still feels a firm thump from the integrated energy under the
  // bell. 64 samples is ample smoothness for an 80 ms pulse.
  const N = 64;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    curve[i] = peak * Math.sin(Math.PI * i / (N - 1));
  }
  gain.gain.setValueCurveAtTime(curve, startTime, duration);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.01);
}
