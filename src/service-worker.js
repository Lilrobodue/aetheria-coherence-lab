// Aetheria Coherence Lab — Service Worker
// Cache-first for modules/assets, network-first for HTML
const CACHE_NAME = 'aetheria-v1.8.0';

const APP_SHELL = [
  './',
  './index.html',
  './main.js',
  './manifest.webmanifest',
  './lib/athena-core.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // streams
  './streams/event-bus.js',
  './streams/ring-buffer.js',
  './streams/stream-registry.js',
  './streams/sensor-health.js',
  // sensors
  './sensors/sensor-base.js',
  './sensors/polar-h10.js',
  './sensors/muse-athena.js',
  // math
  './math/fft.js',
  './math/filters.js',
  './math/hilbert.js',
  './math/digital-root.js',
  './math/stats.js',
  // features
  './features/feature-engine.js',
  './features/heart-features.js',
  './features/respiration.js',
  './features/gut-features.js',
  './features/head-features.js',
  // coherence
  './coherence/regime-scoring.js',
  './coherence/coherence-vector.js',
  './coherence/tcs.js',
  './coherence/cross-regime.js',
  // bcs
  './bcs/kuramoto.js',
  './bcs/mutual-information.js',
  './bcs/memd.js',
  './bcs/phase-transition.js',
  './bcs/bcs-engine.js',
  // policy
  './policy/evaluate-rules.js',
  './policy/arousal-anchor.js',
  './policy/selection-rules.js',
  './policy/state-machine.js',
  // delivery
  './delivery/audio-binaural.js',
  './delivery/haptic-woojer.js',
  './delivery/heartbeat-signature.js',
  './delivery/delivery-coordinator.js',
  // recording (code modules only — session data stays transient)
  './recording/session-recorder.js',
  './recording/session-report.js',
  './recording/session-replay.js',
  // config
  './config/policy.json',
  './config/frequencies.json',
  // viz
  './viz/live-dashboard.js',
  './viz/coherence-panel.js',
  './viz/signal-panel.js',
  './viz/plot-base.js',
];

// --- Install: pre-cache the app shell ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// --- Activate: purge old caches ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('aetheria-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// --- Fetch: network-first for HTML, cache-first for everything else ---
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests — never cache cross-origin (BLE, APIs, etc.)
  if (url.origin !== location.origin) return;

  // Network-first for HTML (so updates land immediately)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for JS modules, JSON config, icons
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
