// recording/session-replay.js
// Replays a recorded session through the event bus at original cadence.
// This lets you re-run the policy engine on historical data for threshold tuning.

export class SessionReplayer {
  constructor(bus, sessionJson) {
    this.bus = bus;
    this._data = sessionJson;
    this._running = false;
    this._speed = 1.0;
    this._timeouts = [];
  }

  get running() { return this._running; }

  /**
   * Replay the session at the given speed multiplier.
   * @param {number} [speed=1.0] - 1.0 = real time, 2.0 = double speed
   * @returns {Promise<void>} resolves when replay completes
   */
  async run(speed = 1.0) {
    if (this._running) return;
    this._running = true;
    this._speed = speed;

    const { streams } = this._data;

    // Build a unified timeline of all events
    const events = [];

    for (const entry of (streams.rr || [])) {
      events.push({ t: entry.t, stream: 'Aetheria_RR', data: { hr_bpm: entry.hr, rr_ms: entry.rr, source: 'replay' } });
    }

    for (const entry of (streams.coherence || [])) {
      events.push({ t: entry.t, stream: 'Aetheria_Coherence', data: { ...entry, source: 'replay' } });
    }

    for (const entry of (streams.features || [])) {
      events.push({ t: entry.t, stream: 'Aetheria_Features', data: { ...entry, type: 'all_features', source: 'replay' } });
    }

    for (const entry of (streams.state || [])) {
      events.push({ t: entry.t, stream: 'Aetheria_State', data: { type: 'state_transition', ...entry, source: 'replay' } });
    }

    for (const entry of (streams.prescription || [])) {
      events.push({ t: entry.t, stream: 'Aetheria_Prescription', data: { ...entry, source: 'replay' } });
    }

    // Sort by time
    events.sort((a, b) => a.t - b.t);

    if (events.length === 0) {
      this._running = false;
      return;
    }

    const startTime = events[0].t;

    // Schedule each event
    return new Promise((resolve) => {
      for (const evt of events) {
        const delay = ((evt.t - startTime) / this._speed) * 1000;
        const timeout = setTimeout(() => {
          if (!this._running) return;
          this.bus.publish(evt.stream, evt.data);
        }, delay);
        this._timeouts.push(timeout);
      }

      // Resolve when last event fires
      const lastDelay = ((events[events.length - 1].t - startTime) / this._speed) * 1000;
      const doneTimeout = setTimeout(() => {
        this._running = false;
        resolve();
      }, lastDelay + 100);
      this._timeouts.push(doneTimeout);
    });
  }

  /** Stop the replay. */
  stop() {
    this._running = false;
    for (const t of this._timeouts) clearTimeout(t);
    this._timeouts = [];
  }
}
