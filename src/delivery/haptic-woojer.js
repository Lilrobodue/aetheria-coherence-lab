// delivery/haptic-woojer.js
// Woojer Strap 3 haptic driver.
//
// The Woojer receives the same stereo signal as the headphones through
// the passive splitter. For frequencies within Woojer range (1-800 Hz),
// the binaural beat naturally produces tactile sensation.
//
// For frequencies ABOVE 800 Hz, this driver mixes a sub-octave sine
// into the stereo channels at controlled amplitude. The headphones hear
// it as a subtle bass undertone; the Woojer feels it as the dominant signal.

export class WoojerDriver {
  constructor(audioContext, destinationNode) {
    this.ctx = audioContext;
    this._dest = destinationNode;
    this._subOsc = null;
    this._subGain = null;
    this._subAmplitude = 0.15; // default mix level for sub-octave
    this._currentFreq = null;
    this._active = false;
  }

  get active() { return this._active; }
  get currentFrequency() { return this._currentFreq; }

  /**
   * Play a haptic frequency. If the target exceeds the Woojer's 800 Hz
   * upper range, plays the sub-octave (freq/2) instead.
   *
   * @param {number} freqHz - target frequency
   */
  async play(freqHz) {
    // Determine the haptic frequency
    let hapticFreq = freqHz;
    while (hapticFreq > 800) {
      hapticFreq /= 2; // drop octaves until in Woojer range
    }

    // If the haptic freq matches the binaural target, the Woojer already
    // receives it through the passive splitter — no extra oscillator needed.
    // Only add a sub-octave oscillator when we've octave-shifted.
    if (hapticFreq === freqHz) {
      // Woojer gets the binaural signal directly
      this._stopSubOsc();
      this._currentFreq = freqHz;
      this._active = true;
      return;
    }

    // Octave-shifted: add a sub-octave sine mixed into the stereo output
    this._stopSubOsc();

    const now = this.ctx.currentTime;
    this._subOsc = this.ctx.createOscillator();
    this._subOsc.type = 'sine';
    this._subOsc.frequency.value = hapticFreq;

    this._subGain = this.ctx.createGain();
    this._subGain.gain.value = 0;
    this._subGain.gain.linearRampToValueAtTime(this._subAmplitude, now + 1);

    this._subOsc.connect(this._subGain);
    this._subGain.connect(this._dest);
    this._subOsc.start(now);

    this._currentFreq = hapticFreq;
    this._active = true;
  }

  /** Stop the sub-octave oscillator. */
  async stop(fadeSec = 2) {
    this._stopSubOsc(fadeSec);
    this._active = false;
    this._currentFreq = null;
  }

  /** Set the sub-octave mix amplitude (0-1). */
  setSubOctaveAmplitude(v) {
    this._subAmplitude = Math.max(0, Math.min(1, v));
    if (this._subGain) {
      this._subGain.gain.setTargetAtTime(this._subAmplitude, this.ctx.currentTime, 0.1);
    }
  }

  _stopSubOsc(fadeSec = 1) {
    if (!this._subOsc) return;
    const now = this.ctx.currentTime;
    const g = this._subGain;
    const o = this._subOsc;
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + fadeSec);
    setTimeout(() => {
      try { o.stop(); o.disconnect(); g.disconnect(); } catch (_) {}
    }, (fadeSec + 0.1) * 1000);
    this._subOsc = null;
    this._subGain = null;
  }
}
