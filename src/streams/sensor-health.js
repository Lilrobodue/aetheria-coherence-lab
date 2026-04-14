// streams/sensor-health.js
// Monitors sensor stream freshness and publishes staleness events.
// Fix #4: system ran 7+ minutes after Muse died with no warning.
//
// Each monitored stream maps to the regimes it feeds. When a stream that
// *has* been seen stops arriving for longer than the threshold, this module
// publishes 'sensor_stale' on the bus. When data resumes, it publishes
// 'sensor_recovered'. The feature engine reads isStale() to gate
// computation on fresh data only.

const STREAM_REGIME_MAP = {
  Aetheria_EEG:   ['HEAD'],
  Aetheria_fNIRS: ['HEAD'],
  Aetheria_ECG:   ['HEART', 'GUT'],
  Aetheria_RR:    ['HEART', 'GUT'],
  Aetheria_PPG:   ['HEAD'],
  Aetheria_IMU:   [],
};

const DEFAULT_THRESHOLD_SEC = 2;
const CHECK_INTERVAL_MS = 1000;

export class SensorHealthMonitor {
  constructor(bus, thresholdSec = DEFAULT_THRESHOLD_SEC) {
    this.bus = bus;
    this.thresholdSec = thresholdSec;
    this._lastSeen = {};    // stream → seconds (performance.now() / 1000)
    this._stale = new Set();
    this._unsubscribers = [];
    this._interval = null;
  }

  start() {
    for (const stream of Object.keys(STREAM_REGIME_MAP)) {
      this._unsubscribers.push(
        this.bus.subscribe(stream, () => {
          this._lastSeen[stream] = performance.now() / 1000;
        })
      );
    }

    this._interval = setInterval(() => this._check(), CHECK_INTERVAL_MS);
    console.log('SensorHealthMonitor: started');
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  /** True if the named stream has been seen at least once and then went silent. */
  isStale(stream) {
    return this._stale.has(stream);
  }

  /** Seconds since the last sample on this stream, or Infinity if never seen. */
  age(stream) {
    const last = this._lastSeen[stream];
    if (last === undefined) return Infinity;
    return performance.now() / 1000 - last;
  }

  _check() {
    const now = performance.now() / 1000;

    for (const [stream, regimes] of Object.entries(STREAM_REGIME_MAP)) {
      const lastSeen = this._lastSeen[stream];

      // Never seen → not stale, just not connected yet
      if (lastSeen === undefined) continue;

      const ageSec = now - lastSeen;
      const wasStale = this._stale.has(stream);

      if (ageSec > this.thresholdSec) {
        if (!wasStale) {
          this._stale.add(stream);
          this.bus.publish('sensor_stale', { stream, regimes, ageSec });
          console.warn(`SensorHealthMonitor: ${stream} stale (${ageSec.toFixed(1)}s)`);
        }
      } else if (wasStale) {
        this._stale.delete(stream);
        this.bus.publish('sensor_recovered', { stream, regimes });
        console.info(`SensorHealthMonitor: ${stream} recovered`);
      }
    }
  }
}
