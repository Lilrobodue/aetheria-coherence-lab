// main.js
// Bootstrap module — wires together all Phase 1 modules.
// Creates the event bus, sensors, signal panel, and dashboard.

import { bus } from './streams/event-bus.js';
import { SensorHealthMonitor } from './streams/sensor-health.js';
import { StreamRegistry } from './streams/stream-registry.js';
import { PolarH10 } from './sensors/polar-h10.js';
import { MuseAthena } from './sensors/muse-athena.js';
import { SignalPanel } from './viz/signal-panel.js';
import { LiveDashboard } from './viz/live-dashboard.js';
import { CoherencePanel } from './viz/coherence-panel.js';
import { FeatureEngine } from './features/feature-engine.js';
import { CoherenceEngine } from './coherence/coherence-vector.js';
import { DeliveryCoordinator } from './delivery/delivery-coordinator.js';
import { PolicyEngine } from './policy/state-machine.js';
import { BCSEngine } from './bcs/bcs-engine.js';
import { SessionRecorder } from './recording/session-recorder.js';
import { generateReport } from './recording/session-report.js';
import { buildTaggerExport, TAGGER_URL } from './recording/tagger-export.js';

// Global app state
const health = new SensorHealthMonitor(bus);

const app = {
  bus,
  health,
  registry: new StreamRegistry(bus),
  polarH10: new PolarH10(bus),
  museAthena: new MuseAthena(bus),
  signalPanel: null,
  featureEngine: null,
  coherenceEngine: null,
  bcsEngine: null,
  delivery: null,
  policy: null,
  policyConfig: null,
  recorder: null,
  frequencies: null,
  coherencePanel: null,
  dashboard: null,
  sessionActive: false
};

let wakeLockSentinel = null;
let pendingSessionData = null;

// Expose app for console debugging
window.aetheria = app;

// --- Initialization ---

async function init() {
  // Check Web Bluetooth support
  if (!navigator.bluetooth) {
    document.getElementById('ble-warning').classList.add('visible');
    document.getElementById('btn-connect-h10').disabled = true;
    document.getElementById('btn-connect-muse').disabled = true;
    console.warn('Web Bluetooth not supported in this browser');
  }

  // Register all known streams for buffering
  app.registry.registerAll();

  // Start sensor health monitor (detects stale streams)
  app.health.start();

  // Surface staleness in the dashboard
  bus.subscribe('sensor_stale', ({ stream, regimes, ageSec }) => {
    console.warn(`SENSOR STALE: ${stream} (${ageSec.toFixed(1)}s) — affects ${regimes.join(', ')}`);
    if (app.dashboard) {
      app.dashboard.addLogEntry(
        `Sensor stale: ${stream} (${ageSec.toFixed(1)}s) — ${regimes.join(', ')} offline`,
        'error'
      );
    }
  });

  bus.subscribe('sensor_recovered', ({ stream, regimes }) => {
    console.info(`SENSOR RECOVERED: ${stream} — regimes back online: ${regimes.join(', ')}`);
    if (app.dashboard) {
      app.dashboard.addLogEntry(
        `Sensor recovered: ${stream} — ${regimes.join(', ')} back online`,
        'sensor'
      );
    }
  });

  // Initialize visualization
  const signalContainer = document.getElementById('signal-container');
  app.signalPanel = new SignalPanel(bus, signalContainer);
  app.signalPanel.init();
  app.signalPanel.start();

  // Initialize feature engine (Phase 2: runs at 1 Hz)
  app.featureEngine = new FeatureEngine(bus, app.health);
  app.featureEngine.start();

  // Initialize coherence engine (Phase 3: TCS at 1 Hz)
  app.coherenceEngine = new CoherenceEngine(bus);
  app.coherenceEngine.start();

  // Initialize BCS engine (Phase 7: proof layer, ~0.1 Hz)
  app.bcsEngine = new BCSEngine(bus, app.policyConfig);
  app.bcsEngine.start();

  // Initialize delivery (Phase 4: audio + haptic)
  app.delivery = new DeliveryCoordinator(bus);
  app.delivery.start();

  // Load frequency library + policy config
  try {
    const [freqResp, configResp] = await Promise.all([
      fetch('config/frequencies.json'),
      fetch('config/policy.json')
    ]);
    app.frequencies = await freqResp.json();
    app.policyConfig = await configResp.json();
    initFrequencySelector();
  } catch (e) {
    console.warn('Could not load config:', e);
  }

  // Listen for baseline calibration from state machine
  bus.subscribe('Aetheria_State', (p) => {
    if (p.type === 'calibrate_baseline' && p.history) {
      app.coherenceEngine.calibrate(p.history);
    }
    if (p.type === 'state_transition') {
      app.dashboard.addLogEntry(p.message, 'decision');
    }
    if (p.type === 'session_info') {
      const s = p;
      document.getElementById('current-state').textContent = s.state || 'IDLE';
      document.getElementById('session-time').textContent = formatTime(s.sessionTime);
      document.getElementById('state-time').textContent = formatTime(s.stateTime);
      if (s.frequency) {
        document.getElementById('current-frequency').textContent =
          `${s.frequency.frequency_hz} Hz · ${s.frequency.name}`;
        document.getElementById('current-frequency').style.display = '';
      }
      if (s.cascade) {
        document.getElementById('cascade-info').textContent =
          `${s.cascade} (${(s.anchor || 0).toFixed(2)})`;
        document.getElementById('cascade-info').style.display = '';
      }
      updateBaselineBanner(s);
    }
    if (p.type === 'phase') {
      app._currentPhase = p.phase;
      updateBaselineBannerPhase(p.phase);
    }
    if (p.type === 'baseline_classified') {
      app._baselineStats = p.baseline;
      app._classification = p.classification;
      showArrivalChip(p.classification);
      showArrivalSummary(p.classification);
      app.dashboard.addLogEntry(`Arrival state classified: ${p.classification}`, 'system');
    }
    if (p.type === 'classification_shift') {
      app._classification = p.to;
      showArrivalChip(p.to);
      app.dashboard.addLogEntry(`Classification shifted: ${p.from} → ${p.to}`, 'decision');
    }
    if (p.type === 'baseline_extended') {
      app.dashboard.addLogEntry(`Baseline extended (${p.extension}) — ${p.reason}`, 'system');
    }
  });

  // CvB indicator: live coherence vs baseline per spec §5.
  bus.subscribe('Aetheria_Coherence', (p) => {
    updateCvbIndicator(p);
  });

  // Initialize coherence panel
  const coherenceContainer = document.getElementById('coherence-container');
  app.coherencePanel = new CoherencePanel(bus);
  app.coherencePanel.init(coherenceContainer);
  app.coherencePanel.start();

  // Initialize dashboard (log, status, session info)
  app.dashboard = new LiveDashboard(bus);
  app.dashboard.init();

  // Wire up live metrics from bus
  initLiveMetrics();

  // Wire up data flow monitor
  initDataFlowMonitor();

  // Arrival-state summary modal wiring
  initArrivalSummaryButtons();

  // Wire up buttons
  document.getElementById('btn-connect-h10').addEventListener('click', connectH10);
  document.getElementById('btn-connect-muse').addEventListener('click', connectMuse);
  document.getElementById('btn-start').addEventListener('click', toggleSession);

  // Session complete modal buttons
  document.getElementById('btn-download-full').addEventListener('click', () => {
    if (!pendingSessionData) return;
    const blob = new Blob([JSON.stringify(pendingSessionData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aetheria-session-${pendingSessionData.metadata.sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  document.getElementById('btn-export-tagger').addEventListener('click', () => {
    if (!pendingSessionData) return;
    downloadTaggerExport(pendingSessionData);
    document.getElementById('tagger-export-confirm').classList.remove('hidden');
  });
  document.getElementById('btn-new-session').addEventListener('click', dismissSessionComplete);

  // Set tagger URLs from constant (not hardcoded in HTML)
  document.getElementById('tagger-link-text').href = TAGGER_URL;
  document.getElementById('tagger-link-text').textContent = TAGGER_URL.replace('https://', '');
  document.getElementById('tagger-link-btn').href = TAGGER_URL;
  document.getElementById('tutorial-tagger-link').href = TAGGER_URL;

  // Re-acquire wake lock when tab becomes visible again
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && app.sessionActive) {
      await acquireWakeLock();
    }
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    app.signalPanel.resize();
  });

  console.log('Aetheria Coherence Lab initialized (Phase 1)');
  app.dashboard.addLogEntry('Lab initialized. Connect sensors to begin.', 'system');
}

// --- Sensor Connection ---

async function connectH10() {
  const btn = document.getElementById('btn-connect-h10');

  if (app.polarH10.isConnected) {
    await app.polarH10.disconnect();
    btn.textContent = 'Connect H10';
    btn.classList.remove('connected');
    updateStartButton();
    return;
  }

  btn.textContent = 'Connecting...';
  btn.disabled = true;

  try {
    await app.polarH10.connect();
    btn.textContent = 'H10 Connected';
    btn.classList.add('connected');
    btn.disabled = false;
    app.dashboard.addLogEntry('Polar H10 connected — HR + R-R', 'sensor');
  } catch (err) {
    btn.textContent = 'Connect H10';
    btn.disabled = false;
    app.dashboard.addLogEntry(`H10 connection failed: ${err.message}`, 'error');
  }

  updateStartButton();
}

async function connectMuse() {
  const btn = document.getElementById('btn-connect-muse');

  if (app.museAthena.isConnected) {
    await app.museAthena.disconnect();
    btn.textContent = 'Connect Muse';
    btn.classList.remove('connected');
    updateStartButton();
    return;
  }

  btn.textContent = 'Connecting...';
  btn.disabled = true;

  try {
    await app.museAthena.connect();
    btn.textContent = 'Muse Connected';
    btn.classList.add('connected');
    btn.disabled = false;
    app.dashboard.addLogEntry('Muse S Athena connected — EEG + fNIRS + PPG + IMU', 'sensor');
  } catch (err) {
    btn.textContent = 'Connect Muse';
    btn.disabled = false;
    app.dashboard.addLogEntry(`Muse connection failed: ${err.message}`, 'error');
  }

  updateStartButton();
}

function updateStartButton() {
  const btn = document.getElementById('btn-start');
  btn.disabled = !(app.polarH10.isConnected || app.museAthena.isConnected);
}

// --- Screen Wake Lock (prevents sleep during active sessions) ---

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    console.warn('[WakeLock] API not supported — screen may sleep during session');
    return;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    console.log('[WakeLock] Screen wake lock acquired');
    wakeLockSentinel.addEventListener('release', () => {
      console.log('[WakeLock] Screen wake lock released');
    });
  } catch (err) {
    console.warn('[WakeLock] Could not acquire:', err.message);
  }
}

async function releaseWakeLock() {
  if (wakeLockSentinel) {
    await wakeLockSentinel.release();
    wakeLockSentinel = null;
  }
}

// --- Session Control ---

async function toggleSession() {
  const btn = document.getElementById('btn-start');

  if (!app.sessionActive) {
    // Initialize audio on user gesture (required by Chrome)
    await app.delivery.init();

    // Reset per-session state on shared singleton engines. The CoherenceEngine
    // and FeatureEngine are created once at init(); without reset, z-scorer
    // calibration from the previous session's baseline persists and distorts
    // the new session's pre-calibration scores (symptom: GUT coherence stuck
    // at ~0.05 with sd≈0.003 in session Joe-new-aetheria-session-2).
    app.coherenceEngine.reset();
    app.featureEngine.reset();
    app.bcsEngine.reset();

    // Start recording
    const sessionId = new Date().toISOString().slice(0, 10) + '_' + Date.now();
    app.recorder = new SessionRecorder(bus, sessionId);
    app.recorder.start();

    // Create and start the policy engine
    app.policy = new PolicyEngine(bus, app.policyConfig || {}, app.frequencies || []);
    app.policy.start();

    app.sessionActive = true;
    await acquireWakeLock();
    app.dashboard.startSession();
    btn.textContent = 'Stop Session';
    btn.style.borderColor = 'var(--error)';
    btn.style.color = 'var(--error)';
  } else {
    if (app.policy) {
      app.policy.stop();
      app.policy = null;
    }
    await app.delivery.stopPlayback();

    // Stop recording and generate report
    if (app.recorder) {
      app.recorder.stop();
      const sessionData = app.recorder.toJSON();
      const report = generateReport(sessionData);

      app.dashboard.addLogEntry(
        `Session report: TCS ${report.baselineTcs}→${report.finalTcs} (peak ${report.peakTcs}), ` +
        `${report.frequenciesPlayed.length} frequencies, ` +
        `${report.advances} advances, ${report.pivots} pivots`,
        'system'
      );

      console.log('Session report:', report);
      showSessionComplete(sessionData);
    }

    await releaseWakeLock();
    app.sessionActive = false;
    btn.textContent = 'Start Session';
    btn.style.borderColor = '';
    btn.style.color = '';
    app.dashboard.addLogEntry('Session stopped by user', 'system');
  }
}

// --- Session Complete ---

function showSessionComplete(sessionData) {
  pendingSessionData = sessionData;
  document.getElementById('tagger-export-confirm').classList.add('hidden');
  document.getElementById('session-complete-modal').classList.remove('hidden');
}

function downloadTaggerExport(fullSession) {
  const exportObj = buildTaggerExport(fullSession);
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = fullSession.metadata.startTime.split('T')[0];
  a.download = `aetheria-tagger-export_${fullSession.metadata.sessionId}_${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function dismissSessionComplete() {
  pendingSessionData = null;
  app.recorder = null;
  document.getElementById('session-complete-modal').classList.add('hidden');
}

function formatTime(sec) {
  if (!sec || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// --- Live Metrics Display ---

function initLiveMetrics() {
  const hrEl = document.getElementById('metric-hr');
  const rrEl = document.getElementById('metric-rr');
  const eegQEl = document.getElementById('metric-eeg-quality');
  const ppgEl = document.getElementById('metric-ppg');

  // Update HR and RR from Polar H10
  bus.subscribe('Aetheria_RR', (payload) => {
    if (hrEl && payload.hr_bpm) hrEl.textContent = Math.round(payload.hr_bpm);
    if (rrEl && payload.rr_ms) rrEl.textContent = Math.round(payload.rr_ms);
  });

  // Update EEG quality from Muse
  let eegUpdateCounter = 0;
  bus.subscribe('Aetheria_EEG', () => {
    eegUpdateCounter++;
    if (eegUpdateCounter % 256 === 0) {
      const quality = app.museAthena.contactQualityScalar;
      if (eegQEl) eegQEl.textContent = (quality * 100).toFixed(0) + '%';
    }
  });

  // Update PPG from Muse (BVP value can be small)
  bus.subscribe('Aetheria_PPG', (payload) => {
    if (ppgEl && payload.heartRate) {
      ppgEl.textContent = payload.heartRate;
    }
  });
}

// --- Data Flow Monitor ---
// Shows live sample counts per stream so you can see what's actually arriving

function initDataFlowMonitor() {
  const flowEl = document.getElementById('data-flow');
  if (!flowEl) return;

  const counters = {};
  const streams = ['Aetheria_ECG', 'Aetheria_RR', 'Aetheria_EEG', 'Aetheria_PPG', 'Aetheria_fNIRS', 'Aetheria_IMU'];

  for (const stream of streams) {
    counters[stream] = 0;
    bus.subscribe(stream, () => { counters[stream]++; });
  }

  setInterval(() => {
    const parts = [];
    for (const stream of streams) {
      const shortName = stream.replace('Aetheria_', '');
      const count = counters[stream];
      const color = count > 0 ? '#00e676' : 'rgba(255,255,255,0.2)';
      parts.push(`<span style="color:${color}">${shortName}:${count}</span>`);
    }
    flowEl.innerHTML = parts.join(' &middot; ');
  }, 1000);
}

// --- Frequency Selector (Phase 4: manual delivery test) ---

function initFrequencySelector() {
  const container = document.getElementById('freq-selector');
  if (!container || !app.frequencies) return;

  const select = document.createElement('select');
  select.style.cssText = 'background:#111128;color:#fff;border:1px solid rgba(255,255,255,0.15);padding:3px 6px;font:inherit;font-size:10px;border-radius:3px;';

  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Select frequency...';
  select.appendChild(opt0);

  // Group by regime with Seed/Bloom labels
  const groups = [
    { label: 'GUT — Seed (174-963 Hz)', filter: f => f.regime === 'GUT' },
    { label: 'HEART — Bloom +243 (1206-3150 Hz)', filter: f => f.regime === 'HEART' },
    { label: 'HEAD — Bloom +354 (3504-6336 Hz)', filter: f => f.regime === 'HEAD' },
  ];
  for (const g of groups) {
    const group = document.createElement('optgroup');
    group.label = g.label;
    for (const f of app.frequencies.filter(g.filter)) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(f);
      opt.textContent = `${f.frequency_hz} Hz · ⌬${f.digital_root} · ${f.name}`;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }

  const playBtn = document.createElement('button');
  playBtn.className = 'btn';
  playBtn.textContent = 'Play';
  playBtn.style.cssText = 'font-size:10px;padding:3px 8px;margin-left:4px;color:var(--success);border-color:var(--success);';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn';
  stopBtn.textContent = 'Stop';
  stopBtn.style.cssText = 'font-size:10px;padding:3px 8px;margin-left:4px;color:var(--error);border-color:var(--error);';

  const hbBtn = document.createElement('button');
  hbBtn.className = 'btn';
  hbBtn.textContent = 'Heartbeat';
  hbBtn.style.cssText = 'font-size:10px;padding:3px 8px;margin-left:4px;color:var(--warning);border-color:var(--warning);';

  playBtn.onclick = async () => {
    if (!select.value) return;
    const freq = JSON.parse(select.value);
    await app.delivery.playFrequency(freq);
    app.dashboard.addLogEntry(`Playing ${freq.frequency_hz} Hz (${freq.regime} · ${freq.name})`, 'decision');
  };

  stopBtn.onclick = async () => {
    await app.delivery.stopPlayback();
    app.dashboard.addLogEntry('Playback stopped', 'system');
  };

  hbBtn.onclick = async () => {
    await app.delivery.playHeartbeat();
    app.dashboard.addLogEntry('Heartbeat signature played', 'system');
  };

  container.appendChild(select);
  container.appendChild(playBtn);
  container.appendChild(stopBtn);
  container.appendChild(hbBtn);
}

// --- Baseline UI (spec §5) ---

const CLASSIFICATION_COPY = {
  regulated_active: {
    tagline: 'Your body is already regulating itself effectively.',
    protocol: 'Protocol: Maintenance — minimal intervention.',
  },
  regulated_stable: {
    tagline: 'You arrived calm and steady.',
    protocol: 'Protocol: Reinforcement — gentle closing tones.',
  },
  mixed: {
    tagline: 'Some regimes are regulated, one is lagging.',
    protocol: 'Protocol: Targeted deficit work.',
  },
  dysregulated: {
    tagline: 'Arriving with widespread low coherence — we\'ll start from the ground up.',
    protocol: 'Protocol: Foundation — GUT grounding first.',
  },
  unstable: {
    tagline: 'Signal variance is high — extending baseline.',
    protocol: 'Protocol: Extended measurement; check sensor contact.',
  },
};

function updateBaselineBannerPhase(phase) {
  const banner = document.getElementById('baseline-banner');
  if (!banner) return;
  banner.classList.toggle('visible', phase === 'baseline');
}

function updateBaselineBanner(sessionInfo) {
  if (sessionInfo.phase !== 'baseline') {
    updateBaselineBannerPhase(sessionInfo.phase);
    return;
  }
  const target = (app.policyConfig && app.policyConfig.baseline_duration_sec) || 90;
  const remaining = Math.max(0, target - Math.floor(sessionInfo.stateTime || 0));
  const el = document.getElementById('bb-countdown-value');
  if (el) el.textContent = remaining;
  updateBaselineBannerPhase('baseline');
  // Signal quality pips: coarse assessment — green/amber/red per regime based
  // on whether the coherence engine has a live sample and it's finite.
  const coh = app.coherenceEngine?.latest;
  const pipFor = (key) => {
    const v = coh && coh[key];
    if (v == null || !isFinite(v)) return 'sq-poor';
    return 'sq-good';
  };
  const setPip = (id, cls) => {
    const el2 = document.getElementById(id);
    if (!el2) return;
    el2.classList.remove('sq-good', 'sq-fair', 'sq-poor');
    el2.classList.add(cls);
  };
  setPip('sq-pip-gut', pipFor('gut'));
  setPip('sq-pip-heart', pipFor('heart'));
  setPip('sq-pip-head', pipFor('head'));
}

function showArrivalChip(classification) {
  const chip = document.getElementById('arrival-chip');
  const val = document.getElementById('arrival-chip-value');
  if (!chip || !val) return;
  chip.className = 'arrival-chip visible c-' + classification;
  val.textContent = classification.replace('_', ' ');
}

function showArrivalSummary(classification) {
  const modal = document.getElementById('arrival-summary-modal');
  const tag = document.getElementById('as-tagline');
  const proto = document.getElementById('as-protocol');
  if (!modal || !tag || !proto) return;
  const copy = CLASSIFICATION_COPY[classification] || CLASSIFICATION_COPY.mixed;
  tag.textContent = `Arrival state: ${classification.replace('_', ' ')} — ${copy.tagline}`;
  proto.textContent = copy.protocol;
  modal.classList.remove('hidden');
}

function hideArrivalSummary() {
  const modal = document.getElementById('arrival-summary-modal');
  if (modal) modal.classList.add('hidden');
}

function updateCvbIndicator(coh) {
  const ind = document.getElementById('cvb-indicator');
  const lbl = document.getElementById('cvb-label');
  if (!ind || !lbl) return;
  const baseline = app._baselineStats;
  if (!baseline || app._currentPhase !== 'prescription') {
    ind.classList.remove('visible');
    return;
  }
  // Use TCS-equivalent: average of per-regime deviations vs baseline mean.
  const regimes = ['gut', 'heart', 'head'];
  const BASELINE_KEY = { gut: 'GUT', heart: 'HEART', head: 'HEAD' };
  let worst = 'green';
  for (const r of regimes) {
    const cur = coh[r];
    const b = baseline[BASELINE_KEY[r]];
    if (cur == null || !b) continue;
    if (cur >= b.mean) continue;
    if (cur >= b.mean - b.sd) { if (worst === 'green') worst = 'amber'; continue; }
    worst = 'red';
  }
  ind.classList.remove('cvb-green', 'cvb-amber', 'cvb-red');
  ind.classList.add('cvb-' + worst, 'visible');
  lbl.textContent = 'CvB ' + worst.toUpperCase();
}

function initArrivalSummaryButtons() {
  const acceptBtn = document.getElementById('btn-arrival-accept');
  const overrideSel = document.getElementById('override-select');
  if (acceptBtn) acceptBtn.addEventListener('click', hideArrivalSummary);
  if (overrideSel) {
    overrideSel.addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v || !app.policy) return;
      app.policy._classification = v;
      bus.publish('Aetheria_State', {
        type: 'classification_shift',
        from: app._classification,
        to: v,
        source: 'user_override',
      });
      app._classification = v;
      showArrivalChip(v);
      hideArrivalSummary();
    });
  }
}

// --- Boot ---
// Gated on disclaimer acknowledgment — nothing initializes until the user
// taps "I understand, let me begin" on the disclaimer modal.

document.addEventListener('aetheria:disclaimer-acknowledged', init);
