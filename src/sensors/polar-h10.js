// sensors/polar-h10.js
//
// Polar H10 Web Bluetooth driver — HR + R-R intervals.
//
// ECG streaming is not supported on Windows due to BLE connection parameter
// limitations. A future version for the Olares One (Linux) will add ECG
// via native BLE using the bridge in bridge/ecg-bridge.py.
//
// R-R intervals are sufficient for all HRV features in Doc 2:
// RMSSD, pNN50, SDNN, HRV coherence, LF/HF, SD1, RSA amplitude.

const HR_SERVICE     = 'heart_rate';
const HR_MEASUREMENT = 'heart_rate_measurement';

export class PolarH10 {
  constructor(bus) {
    this.bus = bus;
    this._status = 'disconnected';
    this._contactQuality = 0;
    this._device = null;
  }

  get status() { return this._status; }
  get isConnected() { return this._status === 'streaming'; }
  get contactQuality() { return this._contactQuality; }
  get ecgActive() { return false; } // Not available on Windows

  _setStatus(s) {
    const prev = this._status;
    this._status = s;
    this.bus.publish('Aetheria_State', {
      type: 'sensor_status', sensor: 'Polar H10', status: s, previousStatus: prev
    });
  }

  _log(msg, type = 'sensor') {
    console.log('H10:', msg);
    this.bus.publish('Aetheria_State', {
      type: 'log', logType: type, message: `H10: ${msg}`
    });
  }

  async connect() {
    if (this._status === 'streaming' || this._status === 'connecting') return;
    this._setStatus('connecting');

    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar H10' }],
        optionalServices: [HR_SERVICE]
      });

      this._device.addEventListener('gattserverdisconnected', () => {
        this._setStatus('disconnected');
        this._log('Disconnected');
      });

      const server = await this._device.gatt.connect();
      const hrSvc = await server.getPrimaryService(HR_SERVICE);
      const hrChar = await hrSvc.getCharacteristic(HR_MEASUREMENT);

      hrChar.addEventListener('characteristicvaluechanged', (e) => {
        this._parseHR(e.target.value);
      });
      await hrChar.startNotifications();

      this._log('HR + R-R streaming');
      this._setStatus('streaming');
    } catch (err) {
      this._log('Connection failed: ' + err.message, 'error');
      this._setStatus('error');
      throw err;
    }
  }

  async disconnect() {
    if (this._device && this._device.gatt.connected) {
      this._device.gatt.disconnect();
    }
    this._device = null;
    this._setStatus('disconnected');
  }

  _parseHR(dv) {
    const flags = dv.getUint8(0);
    let off = 1;
    let hr;

    if (flags & 0x01) { hr = dv.getUint16(off, true); off += 2; }
    else { hr = dv.getUint8(off); off += 1; }

    const contact = (flags & 0x06) === 0x06;
    this._contactQuality = contact ? 1.0 : 0.0;
    if (flags & 0x08) off += 2; // skip energy expended

    // Always publish HR
    this.bus.publish('Aetheria_RR', { hr_bpm: hr, rr_ms: null, source: 'polar_h10' });

    // R-R intervals
    if (flags & 0x10) {
      while (off + 1 < dv.byteLength) {
        const rrMs = (dv.getUint16(off, true) / 1024) * 1000;
        off += 2;
        if (rrMs >= 200 && rrMs <= 2500) {
          this._contactQuality = 1.0;
          this.bus.publish('Aetheria_RR', { rr_ms: rrMs, hr_bpm: hr, source: 'polar_h10' });
        }
      }
    }
  }
}
