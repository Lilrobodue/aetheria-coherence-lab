// delivery/delivery-coordinator.js
// Orchestrates binaural audio + Woojer haptic in sync.
// Subscribes to Aetheria_Prescription events from the policy engine,
// manages crossfades, and publishes Aetheria_Audio / Aetheria_Haptic events.

import { BinauralPlayer } from './audio-binaural.js';
import { WoojerDriver } from './haptic-woojer.js';
import { playHeartbeatSignature } from './heartbeat-signature.js';

export class DeliveryCoordinator {
  constructor(bus, config) {
    this.bus = bus;
    this.config = config || {};

    // Create shared AudioContext
    this._audioCtx = null;
    this._binaural = null;
    this._woojer = null;
    this._unsubscribers = [];
    this._currentFrequency = null;
    this._initialized = false;
  }

  get currentFrequency() { return this._currentFrequency; }
  get playing() { return this._binaural?.playing || false; }

  /**
   * Initialize audio (must be called from a user gesture).
   * Web Audio requires user interaction before creating/resuming context.
   */
  async init() {
    if (this._initialized) return;

    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this._binaural = new BinauralPlayer(this._audioCtx);
    this._woojer = new WoojerDriver(this._audioCtx, this._binaural.masterGain);
    this._initialized = true;

    console.log('DeliveryCoordinator: audio initialized');
  }

  start() {
    // Subscribe to prescription events from the policy engine
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_Prescription', (p) => {
        this._onPrescription(p);
      })
    );
    console.log('DeliveryCoordinator: listening for prescriptions');
  }

  stop() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  /**
   * Manually play a frequency (for testing, or manual override).
   * @param {object} freqEntry - from frequencies.json
   * @param {number} [crossfadeSec=4]
   */
  async playFrequency(freqEntry, crossfadeSec) {
    if (!this._initialized) await this.init();

    const fade = crossfadeSec ?? this.config.crossfade_duration_sec ?? 4;
    const carrierBase = this.config.carrier_base_hz ?? 200;
    const freq = freqEntry.frequency_hz;

    // Octave-shift frequencies above 963 Hz into sub-bass for binaural delivery
    let beatFreq = freq;
    if (beatFreq > 963) {
      while (beatFreq > 80) beatFreq /= 2;
    }

    console.log(`Delivery: playing ${freq} Hz → beat ${beatFreq.toFixed(1)} Hz (${freqEntry.regime} / root ${freqEntry.digital_root}) — ${freqEntry.name}`);

    // Start binaural (carriers at ~200 Hz, beat at sub-bass for high frequencies)
    await this._binaural.play(beatFreq, carrierBase, fade);

    // Start haptic
    await this._woojer.play(freq);

    this._currentFrequency = freqEntry;

    // Publish audio event
    this.bus.publish('Aetheria_Audio', {
      action: 'play',
      frequency_hz: freq,
      regime: freqEntry.regime,
      digital_root: freqEntry.digital_root,
      name: freqEntry.name,
      carrier_base_hz: carrierBase,
      crossfade_sec: fade
    });

    // Publish haptic event
    const hapticFreq = this._woojer.currentFrequency;
    this.bus.publish('Aetheria_Haptic', {
      action: 'play',
      target_frequency_hz: freq,
      haptic_frequency_hz: hapticFreq,
      octave_shifted: hapticFreq !== freq,
      transducer_id: 'woojer_strap_3'
    });
  }

  /** Stop all playback. */
  async stopPlayback(fadeSec = 2) {
    if (!this._initialized) return;
    await this._binaural.stop(fadeSec);
    await this._woojer.stop(fadeSec);
    this._currentFrequency = null;

    this.bus.publish('Aetheria_Audio', { action: 'stop' });
    this.bus.publish('Aetheria_Haptic', { action: 'stop' });
  }

  /** Play the closing heartbeat signature. */
  async playHeartbeat() {
    if (!this._initialized) await this.init();
    console.log('Delivery: playing heartbeat signature');
    await playHeartbeatSignature(this._audioCtx, this._binaural.masterGain);
  }

  /** Set master volume (0-1). */
  setVolume(v) {
    if (this._binaural) this._binaural.setVolume(v);
  }

  _onPrescription(p) {
    if (p.action === 'play' && p.frequency) {
      this.playFrequency(p.frequency, p.crossfade_sec);
    } else if (p.action === 'stop') {
      this.stopPlayback();
    } else if (p.action === 'heartbeat') {
      this.playHeartbeat();
    }
  }
}
