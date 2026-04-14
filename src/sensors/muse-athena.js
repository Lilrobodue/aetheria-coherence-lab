// sensors/muse-athena.js
// Event bus wrapper around the AthenaDevice (athena-core.js) library.
// AthenaDevice handles all BLE protocol, decoding, and DSP.
// This module bridges its callbacks into the Aetheria event bus.
//
// AthenaDevice is loaded as a global (window.AthenaDevice) via <script> tag
// because athena-core.js uses IIFE export pattern, not ES modules.

const EEG_LABELS = ['TP9', 'AF7', 'AF8', 'TP10'];

export class MuseAthena {
  constructor(bus) {
    this.bus = bus;
    this._status = 'disconnected';
    this._device = null; // AthenaDevice instance
    this._channelQuality = { TP9: 0, AF7: 0, AF8: 0, TP10: 0 };
    this._battery = null;
    this._eegSampleCount = 0;
  }

  get status() { return this._status; }
  get isConnected() { return this._status === 'streaming'; }
  get battery() { return this._battery; }

  get contactQuality() { return this._channelQuality; }

  get contactQualityScalar() {
    const vals = Object.values(this._channelQuality);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  async connect() {
    if (this._status === 'streaming' || this._status === 'connecting') return;

    if (typeof AthenaDevice === 'undefined') {
      throw new Error('AthenaDevice not loaded. Include athena-core.js before this module.');
    }

    this._setStatus('connecting');

    this._device = new AthenaDevice({
      preset: 'p1041', // Full: EEG8 + Optics16 (recommended for Athena)

      onEEG: (data) => this._onEEG(data),
      onPPG: (data) => this._onPPG(data),
      onFNIRS: (data) => this._onFNIRS(data),
      onAccGyro: (data) => this._onAccGyro(data),
      onBandPowers: (bp) => this._onBandPowers(bp),
      onBattery: (pct) => {
        this._battery = pct;
        this.bus.publish('Aetheria_State', {
          type: 'battery',
          sensor: 'Muse S Athena',
          percent: pct
        });
      },
      onStatus: (s) => {
        if (s === 'streaming') this._setStatus('streaming');
        else if (s === 'disconnected') this._setStatus('disconnected');
      },
      onLog: (type, msg) => {
        console.log(`[Muse ${type}] ${msg}`);
      }
    });

    try {
      await this._device.connect();
      await this._device.startStream();
      this._setStatus('streaming');
    } catch (err) {
      this._setStatus('error');
      throw err;
    }
  }

  async disconnect() {
    if (this._device) {
      await this._device.disconnect();
    }
    this._setStatus('disconnected');
    this._device = null;
  }

  _setStatus(status) {
    const prev = this._status;
    this._status = status;
    this.bus.publish('Aetheria_State', {
      type: 'sensor_status',
      sensor: 'Muse S Athena',
      status,
      previousStatus: prev
    });
  }

  // --- AthenaDevice callback handlers → event bus ---

  _onEEG(data) {
    // Batch publish: one event per notification with all samples,
    // instead of one event per sample per channel (was 1024 events/s).
    const nSamples = data.samples.length;
    const nCh = Math.min(data.samples[0]?.length || 0, 4);
    if (nCh === 0 || nSamples === 0) return;

    // Build batch arrays per channel
    const batch = {};
    for (let c = 0; c < nCh; c++) {
      const channelName = EEG_LABELS[c];
      const values = new Float32Array(nSamples);
      for (let s = 0; s < nSamples; s++) {
        values[s] = data.samples[s][c];
      }
      batch[channelName] = values;

      // Update contact quality using batch RMS (phase-independent)
      let sumSq = 0;
      for (let s = 0; s < nSamples; s++) sumSq += values[s] * values[s];
      const rms = Math.sqrt(sumSq / nSamples);
      // Good contact: RMS in physiological EEG range (1–200 µV)
      // Below 1 µV = no signal / rail; above 200 µV = movement artifact
      const good = rms > 1 && rms < 200;
      const prev = this._channelQuality[channelName];
      // Asymmetric smoothing: rise fast (~1s to 50%), fall slow (~3.5s to half)
      this._channelQuality[channelName] = good
        ? Math.min(1, prev + 0.15 * (1 - prev))
        : prev * 0.95;
    }

    this.bus.publish('Aetheria_EEG', {
      batch,
      sampleCount: nSamples,
      startIndex: this._eegSampleCount,
      source: 'muse_athena'
    });

    this._eegSampleCount += nSamples;
  }

  _onPPG(data) {
    if (!data || !data.bvp) return;

    // Batch publish: one event with the full BVP array
    this.bus.publish('Aetheria_PPG', {
      batch: data.bvp,
      sqi: data.sqi,
      heartRate: data.heartRate,
      source: 'muse_athena'
    });
  }

  _onFNIRS(data) {
    // data = { LO: {hbo:[], hbr:[], hbdiff:[], sqi, lastHbO, lastHbR, lastHbDiff}, ... }
    if (!data) return;

    const positions = Object.keys(data);
    if (positions.length === 0) return;

    // The full hbo/hbr arrays contain the time-series waveform at 64 Hz
    // (processed through mBLL + bandpass 0.01-0.1 Hz).
    // We publish the LAST ~2 seconds of the averaged waveform so the
    // signal panel shows the actual hemodynamic oscillation, not just
    // a single point that rounds to zero.

    // Average the hbo/hbr arrays across positions
    const firstPos = data[positions[0]];
    const len = firstPos.hbo.length;
    if (len === 0) return;

    // Take the last 128 samples (~2s at 64 Hz) for the plot
    const tailLen = Math.min(128, len);
    const startIdx = len - tailLen;

    for (let i = startIdx; i < len; i++) {
      let hbOAvg = 0, hbRAvg = 0;
      for (const pos of positions) {
        const posData = data[pos];
        // hbo/hbr are regular arrays (Array.from'd in athena-core.js)
        hbOAvg += posData.hbo[i];
        hbRAvg += posData.hbr[i];
      }
      hbOAvg /= positions.length;
      hbRAvg /= positions.length;

      this.bus.publish('Aetheria_fNIRS', {
        hbO: hbOAvg,
        hbR: hbRAvg,
        hbDiff: hbOAvg - hbRAvg,
        sqi: firstPos.sqi,
        positions: null, // don't duplicate the full data every sample
        source: 'muse_athena'
      });
    }
  }

  _onAccGyro(data) {
    if (!data) return;

    for (const row of data.samples) {
      this.bus.publish('Aetheria_IMU', {
        type: 'accgyro',
        x: row[0], y: row[1], z: row[2],
        gx: row[3], gy: row[4], gz: row[5],
        source: 'muse_athena'
      });
    }
  }

  _onBandPowers(bp) {
    this.bus.publish('Aetheria_Features', {
      type: 'band_powers',
      delta: bp.delta,
      theta: bp.theta,
      alpha: bp.alpha,
      beta: bp.beta,
      gamma: bp.gamma,
      source: 'muse_athena'
    });
  }
}
