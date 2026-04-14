// streams/stream-registry.js
// Central registry of active streams. Each stream gets a RingBuffer
// and metadata about its expected rate and channel count.

import { RingBuffer } from './ring-buffer.js';

// Stream definitions matching Doc 1 LSL inlet/outlet tables
const STREAM_DEFS = {
  // Sensor inlets
  Aetheria_ECG:    { rate: 130, channels: 1,  type: 'float', source: 'Polar H10' },
  Aetheria_RR:     { rate: 1,   channels: 1,  type: 'float', source: 'Polar H10' },
  Aetheria_EEG:    { rate: 256, channels: 4,  type: 'float', source: 'Muse S Athena' },
  Aetheria_fNIRS:  { rate: 10,  channels: 4,  type: 'float', source: 'Muse S Athena' },
  Aetheria_PPG:    { rate: 64,  channels: 1,  type: 'float', source: 'Muse S Athena' },
  Aetheria_IMU:    { rate: 52,  channels: 6,  type: 'float', source: 'Muse S Athena' },

  // Event streams
  Aetheria_Audio:        { rate: 1, channels: 1, type: 'string', source: 'Player' },
  Aetheria_Haptic:       { rate: 1, channels: 1, type: 'string', source: 'Haptic engine' },

  // Derived streams (populated by later phases)
  Aetheria_Features:     { rate: 1,  channels: 20, type: 'float', source: 'Feature engine' },
  Aetheria_Coherence:    { rate: 1,  channels: 4,  type: 'float', source: 'Coherence engine' },
  Aetheria_State:        { rate: 0.1, channels: 1, type: 'string', source: 'Policy engine' },
  Aetheria_Prescription: { rate: 0.1, channels: 1, type: 'string', source: 'Policy engine' },
  Aetheria_BCS:          { rate: 0.1, channels: 1, type: 'float', source: 'BCS engine' }
};

export class StreamRegistry {
  constructor(bus, bufferDurationSec = 60) {
    this.bus = bus;
    this.bufferDurationSec = bufferDurationSec;
    this._streams = new Map();
    this._unsubscribers = [];
  }

  // Register and start buffering a stream
  register(streamName) {
    const def = STREAM_DEFS[streamName];
    if (!def) {
      console.warn(`StreamRegistry: unknown stream "${streamName}"`);
      return null;
    }

    const buffer = new RingBuffer(this.bufferDurationSec, def.rate);
    const entry = { ...def, name: streamName, buffer, active: false };
    this._streams.set(streamName, entry);

    // Auto-subscribe to the bus and buffer incoming data
    const unsub = this.bus.subscribe(streamName, (payload) => {
      entry.active = true;
      buffer.push(payload, payload.timestamp);
    });
    this._unsubscribers.push(unsub);

    return entry;
  }

  // Register all known streams
  registerAll() {
    for (const name of Object.keys(STREAM_DEFS)) {
      this.register(name);
    }
  }

  get(streamName) {
    return this._streams.get(streamName) || null;
  }

  getBuffer(streamName) {
    const entry = this._streams.get(streamName);
    return entry ? entry.buffer : null;
  }

  // Get list of active (receiving data) streams
  getActiveStreams() {
    return [...this._streams.values()].filter(s => s.active);
  }

  getAllStreams() {
    return [...this._streams.values()];
  }

  dispose() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
    for (const entry of this._streams.values()) entry.buffer.clear();
    this._streams.clear();
  }
}

export { STREAM_DEFS };
