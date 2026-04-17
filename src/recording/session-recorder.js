// recording/session-recorder.js
// Records all event bus streams during a session as timestamped JSON.
// Every stream is captured: sensor data, features, coherence, state transitions,
// prescriptions, and audio/haptic events.
//
// The recording is the labeled training data for the eventual v2 ML policy
// and can be replayed through the system for threshold tuning.

export class SessionRecorder {
  constructor(bus, sessionId, userId) {
    this.bus = bus;
    this.sessionId = sessionId || `${new Date().toISOString().slice(0, 10)}_${Date.now()}`;
    this.userId = userId || 'default';
    this._recording = false;
    this._unsubscribers = [];
    this._startTime = null;

    // Recorded data organized by stream
    this._streams = {
      rr: [],
      eeg: [],
      ppg: [],
      fnirs: [],
      imu: [],
      features: [],
      coherence: [],
      state: [],
      prescription: [],
      bcs: [],
      audio: [],
      haptic: []
    };

    // Metadata
    this._metadata = {
      sessionId: this.sessionId,
      userId: this.userId,
      startTime: null,
      endTime: null,
      softwareVersion: '1.0.0',
      sensors: []
    };

    // Downsampled counters (don't record every single EEG/PPG sample)
    this._eegCounter = 0;
    this._ppgCounter = 0;
  }

  get recording() { return this._recording; }
  get sampleCount() {
    let total = 0;
    for (const arr of Object.values(this._streams)) total += arr.length;
    return total;
  }

  start() {
    if (this._recording) return;
    this._recording = true;
    this._startTime = performance.now() / 1000;
    this._metadata.startTime = new Date().toISOString();

    // Subscribe to all relevant streams
    this._sub('Aetheria_RR', (p) => {
      this._streams.rr.push({
        t: this._relTime(p.timestamp),
        hr: p.hr_bpm,
        rr: p.rr_ms
      });
    });

    // EEG: record one snapshot per second (heavily downsampled)
    this._sub('Aetheria_EEG', (p) => {
      this._eegCounter++;
      if (this._eegCounter % 64 !== 0) return; // ~4 Hz from batch events
      if (p.batch) {
        // Record last sample from each channel
        const snapshot = {};
        for (const [ch, vals] of Object.entries(p.batch)) {
          snapshot[ch] = +(vals[vals.length - 1]).toFixed(2);
        }
        this._streams.eeg.push({ t: this._relTime(p.timestamp), ...snapshot });
      }
    });

    // PPG: record downsampled
    this._sub('Aetheria_PPG', (p) => {
      this._ppgCounter++;
      if (this._ppgCounter % 4 !== 0) return;
      const v = p.batch ? p.batch[p.batch.length - 1] : p.value;
      this._streams.ppg.push({
        t: this._relTime(p.timestamp),
        v: +(v || 0).toFixed(3),
        hr: p.heartRate
      });
    });

    this._sub('Aetheria_fNIRS', (p) => {
      this._streams.fnirs.push({
        t: this._relTime(p.timestamp),
        hbO: p.hbO,
        hbR: p.hbR
      });
    });

    // Features: 1 Hz, full object
    this._sub('Aetheria_Features', (p) => {
      if (p.type !== 'all_features') return;
      this._streams.features.push({
        t: this._relTime(p.timestamp),
        heart: p.heart ? { ...p.heart } : null,
        gut: p.gut ? { ...p.gut } : null,
        head: p.head ? {
          alphaPowerNorm: p.head.alphaPowerNorm,
          thetaAlphaRatio: p.head.thetaAlphaRatio,
          frontalAlphaAsymmetry: p.head.frontalAlphaAsymmetry,
          betaPower: p.head.betaPower,
          hbDiff: p.head.hbDiff,
          iaf: p.head.iaf
        } : null,
        resp: p.respiration || null
      });
    });

    // Coherence: 1 Hz
    this._sub('Aetheria_Coherence', (p) => {
      this._streams.coherence.push({
        t: this._relTime(p.timestamp),
        tcs: +((p.tcs || 0).toFixed(1)),
        gut: +((p.gut || 0).toFixed(3)),
        heart: +((p.heart || 0).toFixed(3)),
        head: +((p.head || 0).toFixed(3)),
        plv: +((p.triunePLV || 0).toFixed(3)),
        harm: +((p.harmonicLock || 0).toFixed(3)),
        deficit: p.deficit,
        lead: p.lead
      });
    });

    // BCS: ~0.1 Hz (proof layer)
    // Calibrated 2026-04-17 after session analysis: preserve null for
    // no-measurement ticks instead of coercing to 0 — downstream consumers
    // must distinguish "no measurement" from "zero measurement."
    const round = (v, d) => v == null ? null : +v.toFixed(d);
    this._sub('Aetheria_BCS', (p) => {
      this._streams.bcs.push({
        t: this._relTime(p.timestamp),
        bcs: round(p.bcs, 1),
        bcsQuality: p.bcsQuality || null,
        kuramoto: round(p.kuramoto, 3),
        sharedEnergy: round(p.sharedEnergy, 3),
        sharedEnergyQuality: p.sharedEnergyQuality || null,
        mutualInfo: round(p.mutualInfo, 3),
        phaseTransition: p.phaseTransition?.detected || false
      });
    });

    // State transitions: event-based
    this._sub('Aetheria_State', (p) => {
      if (p.type === 'state_transition') {
        this._streams.state.push({
          t: this._relTime(p.timestamp),
          from: p.from,
          to: p.to,
          reason: p.reason
        });
      }
    });

    // Prescriptions: event-based
    this._sub('Aetheria_Prescription', (p) => {
      this._streams.prescription.push({
        t: this._relTime(p.timestamp),
        action: p.action,
        freq: p.frequency?.frequency_hz,
        regime: p.frequency?.regime,
        name: p.frequency?.name
      });
    });

    // Audio/Haptic: event-based
    this._sub('Aetheria_Audio', (p) => {
      this._streams.audio.push({ t: this._relTime(p.timestamp), ...p });
    });
    this._sub('Aetheria_Haptic', (p) => {
      this._streams.haptic.push({ t: this._relTime(p.timestamp), ...p });
    });

    console.log('SessionRecorder: recording started');
  }

  stop() {
    if (!this._recording) return;
    this._recording = false;
    this._metadata.endTime = new Date().toISOString();

    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];

    console.log(`SessionRecorder: stopped (${this.sampleCount} samples recorded)`);
  }

  /** Export the full session as a JSON object. */
  toJSON() {
    return {
      metadata: this._metadata,
      streams: this._streams
    };
  }

  /** Trigger a file download of the session JSON. */
  download() {
    const data = this.toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aetheria-session-${this.sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('SessionRecorder: download triggered');
  }

  _sub(streamName, handler) {
    this._unsubscribers.push(this.bus.subscribe(streamName, handler));
  }

  _relTime(timestamp) {
    return +((timestamp - this._startTime).toFixed(2));
  }
}
