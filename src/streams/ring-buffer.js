// streams/ring-buffer.js
// 60-second rolling window per stream. Lock-free single-producer/single-consumer.
// Aligned to event bus timestamps, NOT wall-clock time.

export class RingBuffer {
  constructor(maxDurationSec = 60, expectedRate = 1) {
    this.maxDurationSec = maxDurationSec;
    // Pre-allocate for expected capacity + headroom
    this._capacity = Math.ceil(maxDurationSec * expectedRate * 1.2);
    this._data = [];
    this._timestamps = [];
  }

  push(value, timestamp) {
    this._data.push(value);
    this._timestamps.push(timestamp);

    // Evict samples older than maxDurationSec from the newest
    const cutoff = timestamp - this.maxDurationSec;
    while (this._timestamps.length > 0 && this._timestamps[0] < cutoff) {
      this._data.shift();
      this._timestamps.shift();
    }
  }

  // Push multiple samples at once (e.g. for batch BLE notifications)
  pushBatch(values, timestamps) {
    for (let i = 0; i < values.length; i++) {
      this.push(values[i], timestamps[i]);
    }
  }

  // Get all samples in the window
  getAll() {
    return {
      data: this._data.slice(),
      timestamps: this._timestamps.slice()
    };
  }

  // Get the last N seconds of data
  getWindow(durationSec) {
    if (this._timestamps.length === 0) return { data: [], timestamps: [] };

    const cutoff = this._timestamps[this._timestamps.length - 1] - durationSec;
    let startIdx = 0;
    for (let i = 0; i < this._timestamps.length; i++) {
      if (this._timestamps[i] >= cutoff) {
        startIdx = i;
        break;
      }
    }

    return {
      data: this._data.slice(startIdx),
      timestamps: this._timestamps.slice(startIdx)
    };
  }

  // Get the most recent sample
  latest() {
    if (this._data.length === 0) return null;
    return {
      value: this._data[this._data.length - 1],
      timestamp: this._timestamps[this._timestamps.length - 1]
    };
  }

  get length() {
    return this._data.length;
  }

  get duration() {
    if (this._timestamps.length < 2) return 0;
    return this._timestamps[this._timestamps.length - 1] - this._timestamps[0];
  }

  // Fraction of expected samples present (for missing data detection)
  coverage(expectedRate) {
    if (this.duration === 0) return 0;
    const expected = this.duration * expectedRate;
    return Math.min(1, this._data.length / expected);
  }

  clear() {
    this._data = [];
    this._timestamps = [];
  }
}
