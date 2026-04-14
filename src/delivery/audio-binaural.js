// delivery/audio-binaural.js
// Web Audio binaural beat generator.
//
// For each target frequency f, generates two sine carriers — one per ear —
// whose difference equals f. The brain reconstructs the binaural beat
// internally, driving entrainment more effectively than a mono tone.
//
// Carriers are placed in the 200-400 Hz range (comfortable hearing).
// Crossfade between frequencies over a configurable duration.

export class BinauralPlayer {
  constructor(audioContext) {
    this.ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    this._masterGain = this.ctx.createGain();
    this._masterGain.gain.value = 0.3;
    this._masterGain.connect(this.ctx.destination);

    // Current playing state
    this._leftOsc = null;
    this._rightOsc = null;
    this._leftGain = null;
    this._rightGain = null;
    this._merger = null;
    this._currentFreq = null;
    this._playing = false;
  }

  get playing() { return this._playing; }
  get currentFrequency() { return this._currentFreq; }

  /**
   * Play a binaural beat at the target frequency.
   * If already playing, crossfades from the current frequency.
   *
   * @param {number} targetFreqHz - the binaural difference frequency
   * @param {number} [carrierBaseHz=200] - base carrier frequency
   * @param {number} [crossfadeSec=4] - crossfade duration
   */
  async play(targetFreqHz, carrierBaseHz = 200, crossfadeSec = 4) {
    // Resume AudioContext if suspended (Chrome autoplay policy)
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    const now = this.ctx.currentTime;
    const carrierLeft = carrierBaseHz;
    const carrierRight = carrierBaseHz + targetFreqHz;

    if (this._playing) {
      // Crossfade: ramp down old, create new, ramp up
      this._fadeOut(crossfadeSec);
    }

    // Create stereo routing: left osc → left channel, right osc → right channel
    const merger = this.ctx.createChannelMerger(2);

    const leftGain = this.ctx.createGain();
    const rightGain = this.ctx.createGain();
    leftGain.gain.value = 0;
    rightGain.gain.value = 0;

    const leftOsc = this.ctx.createOscillator();
    leftOsc.type = 'sine';
    leftOsc.frequency.value = carrierLeft;

    const rightOsc = this.ctx.createOscillator();
    rightOsc.type = 'sine';
    rightOsc.frequency.value = carrierRight;

    // Route: left osc → left gain → merger[0], right osc → right gain → merger[1]
    leftOsc.connect(leftGain);
    leftGain.connect(merger, 0, 0);

    rightOsc.connect(rightGain);
    rightGain.connect(merger, 0, 1);

    merger.connect(this._masterGain);

    leftOsc.start(now);
    rightOsc.start(now);

    // Ramp up
    leftGain.gain.setValueAtTime(0, now);
    leftGain.gain.linearRampToValueAtTime(1, now + crossfadeSec);
    rightGain.gain.setValueAtTime(0, now);
    rightGain.gain.linearRampToValueAtTime(1, now + crossfadeSec);

    // Store references
    this._leftOsc = leftOsc;
    this._rightOsc = rightOsc;
    this._leftGain = leftGain;
    this._rightGain = rightGain;
    this._merger = merger;
    this._currentFreq = targetFreqHz;
    this._playing = true;
  }

  /** Fade out and stop current playback. */
  async stop(fadeSec = 2) {
    if (!this._playing) return;
    this._fadeOut(fadeSec);
    this._playing = false;
    this._currentFreq = null;
  }

  /** Set master volume (0-1). */
  setVolume(v) {
    this._masterGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, v)),
      this.ctx.currentTime, 0.05
    );
  }

  _fadeOut(fadeSec) {
    if (!this._leftGain || !this._rightGain) return;
    const now = this.ctx.currentTime;

    // Capture current references before they get replaced
    const lg = this._leftGain;
    const rg = this._rightGain;
    const lo = this._leftOsc;
    const ro = this._rightOsc;
    const merger = this._merger;

    lg.gain.setValueAtTime(lg.gain.value, now);
    lg.gain.linearRampToValueAtTime(0, now + fadeSec);
    rg.gain.setValueAtTime(rg.gain.value, now);
    rg.gain.linearRampToValueAtTime(0, now + fadeSec);

    // Stop and disconnect after fade
    setTimeout(() => {
      try {
        lo.stop(); ro.stop();
        lo.disconnect(); ro.disconnect();
        lg.disconnect(); rg.disconnect();
        merger.disconnect();
      } catch (_) {}
    }, (fadeSec + 0.1) * 1000);
  }

  /** Get the AudioContext (for Woojer driver to share). */
  get audioContext() { return this.ctx; }

  /** Get the master gain node (for routing). */
  get masterGain() { return this._masterGain; }
}
