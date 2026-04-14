// viz/live-dashboard.js
// The main observability window. Orchestrates all viz panels and displays
// sensor status, session state, and the transition log.

export class LiveDashboard {
  constructor(bus) {
    this.bus = bus;
    this._statusEl = null;
    this._logEl = null;
    this._logEntries = [];
    this._unsubscribers = [];
    this._sessionStartTime = null;
    this._stateStartTime = null;
  }

  init() {
    this._statusEl = document.getElementById('status-bar');
    this._logEl = document.getElementById('transition-log');

    // Subscribe to state changes for the transition log
    const unsub = this.bus.subscribe('Aetheria_State', (payload) => {
      this._onStateEvent(payload);
    });
    this._unsubscribers.push(unsub);
  }

  updateSensorStatus(name, status) {
    const el = document.getElementById(`status-${name.replace(/\s+/g, '-').toLowerCase()}`);
    if (!el) return;

    el.className = `sensor-status sensor-${status}`;
    el.querySelector('.status-text').textContent = status.toUpperCase();

    // Update indicator dot
    const dot = el.querySelector('.status-dot');
    if (dot) {
      dot.className = `status-dot dot-${status}`;
    }
  }

  updateSessionInfo(state, frequency, cascade, anchor) {
    const stateEl = document.getElementById('current-state');
    const freqEl = document.getElementById('current-frequency');
    const cascadeEl = document.getElementById('cascade-info');
    const sessionTimeEl = document.getElementById('session-time');
    const stateTimeEl = document.getElementById('state-time');

    if (stateEl) stateEl.textContent = state || '--';
    if (freqEl) freqEl.textContent = frequency || '--';
    if (cascadeEl) cascadeEl.textContent = cascade
      ? `${cascade.direction} (anchor: ${cascade.anchor.toFixed(2)})`
      : '--';
    if (sessionTimeEl && this._sessionStartTime) {
      sessionTimeEl.textContent = this._formatDuration(
        performance.now() / 1000 - this._sessionStartTime
      );
    }
    if (stateTimeEl && this._stateStartTime) {
      stateTimeEl.textContent = this._formatDuration(
        performance.now() / 1000 - this._stateStartTime
      );
    }
  }

  addLogEntry(message, type = 'info') {
    const time = this._sessionStartTime
      ? this._formatDuration(performance.now() / 1000 - this._sessionStartTime)
      : '--:--';

    const entry = { time, message, type, timestamp: performance.now() };
    this._logEntries.unshift(entry); // newest first
    if (this._logEntries.length > 100) this._logEntries.pop();

    this._renderLog();
  }

  _onStateEvent(payload) {
    if (payload.type === 'sensor_status') {
      this.updateSensorStatus(payload.sensor, payload.status);
      this.addLogEntry(
        `${payload.sensor}: ${payload.previousStatus} -> ${payload.status}`,
        'sensor'
      );
    } else if (payload.type === 'log') {
      this.addLogEntry(payload.message, payload.logType || 'info');
    }
  }

  startSession() {
    this._sessionStartTime = performance.now() / 1000;
    this._stateStartTime = this._sessionStartTime;
    this.addLogEntry('Session started', 'system');
  }

  _renderLog() {
    if (!this._logEl) return;

    this._logEl.innerHTML = this._logEntries.map(entry => {
      const typeClass = `log-${entry.type}`;
      return `<div class="log-entry ${typeClass}">
        <span class="log-time">${entry.time}</span>
        <span class="log-msg">${entry.message}</span>
      </div>`;
    }).join('');
  }

  _formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  dispose() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }
}
