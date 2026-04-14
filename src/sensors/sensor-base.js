// sensors/sensor-base.js
// Shared base class for BLE sensors: connect, disconnect, status lifecycle.

export class SensorBase {
  constructor(bus, name) {
    this.bus = bus;
    this.name = name;
    this._status = 'disconnected';
    this._device = null;
    this._server = null;
    this._contactQuality = 0;
  }

  get status() { return this._status; }
  get contactQuality() { return this._contactQuality; }
  get isConnected() { return this._status === 'streaming'; }

  _setStatus(status) {
    const prev = this._status;
    this._status = status;
    this.bus.publish('Aetheria_State', {
      type: 'sensor_status',
      sensor: this.name,
      status,
      previousStatus: prev
    });
  }

  async connect() {
    if (this._status === 'streaming' || this._status === 'connecting') return;

    this._setStatus('connecting');
    try {
      this._device = await this._requestDevice();
      this._device.addEventListener('gattserverdisconnected', () => {
        this._setStatus('disconnected');
        this._server = null;
      });

      this._server = await this._device.gatt.connect();
      await this._startNotifications(this._server);
      this._setStatus('streaming');
    } catch (err) {
      console.error(`${this.name} connection failed:`, err);
      this._setStatus('error');
      throw err;
    }
  }

  async disconnect() {
    if (this._device && this._device.gatt.connected) {
      this._device.gatt.disconnect();
    }
    this._setStatus('disconnected');
    this._server = null;
  }

  // Subclasses must implement these
  async _requestDevice() {
    throw new Error('Subclass must implement _requestDevice()');
  }

  async _startNotifications(server) {
    throw new Error('Subclass must implement _startNotifications()');
  }
}
