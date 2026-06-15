// coherence/interval-session.js
// App-specific glue between the shared IntervalAnalysis module and a Coherence
// Lab session (multi-app update spec, App 2).
//
// Pure functions only — the IntervalAnalysis API (`IA`) is passed in rather
// than read from window/globalThis, so this module is fully testable under Node
// and never couples to a particular module-loading order. The browser passes
// `window.IntervalAnalysis`; tests pass the same API after importing the lib.

/**
 * Smallest-factor primality test, for the "primes are the mountains" number
 * line (spec §App-2.5). Primes are the fixed landmarks; 3-6-9 frequencies are
 * the river that flows between them.
 * @param {number} n
 * @returns {boolean}
 */
export function isPrime(n) {
  n = Math.round(Math.abs(n));
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  if (n % 3 === 0) return n === 3;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

/**
 * Distinct frequencies the policy engine actually delivered during a session,
 * in first-played order, shaped as interval-analysis peaks. Reads the
 * recorder's `streams.prescription` play events.
 * @param {object} sessionJson - full session ({ metadata, streams })
 * @returns {Array<{hz:number,name:?string,regime:?string}>}
 */
export function extractPlayedPeaks(sessionJson) {
  const presc = (sessionJson && sessionJson.streams && sessionJson.streams.prescription) || [];
  const seen = new Set();
  const peaks = [];
  for (const p of presc) {
    if (p.action !== 'play') continue;
    const hz = p.freq;
    if (!Number.isFinite(hz) || hz <= 0 || seen.has(hz)) continue;
    seen.add(hz);
    peaks.push({ hz, name: p.name || null, regime: p.regime || null });
  }
  return peaks;
}

/**
 * The full 27-position Aetheria library as interval-analysis peaks.
 * @param {Array} frequencies - config/frequencies.json
 * @returns {Array<{hz:number,name:?string,regime:?string}>}
 */
export function libraryPeaks(frequencies) {
  return (frequencies || [])
    .filter(f => f && Number.isFinite(f.frequency_hz))
    .map(f => ({ hz: f.frequency_hz, name: f.name, regime: f.regime }));
}

/**
 * Session wall-clock duration in minutes from metadata ISO timestamps, falling
 * back to the span of the coherence stream when timestamps are absent.
 * @param {object} sessionJson
 * @returns {number} minutes (0 if undeterminable)
 */
export function sessionDurationMinutes(sessionJson) {
  const m = sessionJson && sessionJson.metadata;
  if (m && m.startTime && m.endTime) {
    const ms = new Date(m.endTime).getTime() - new Date(m.startTime).getTime();
    if (isFinite(ms) && ms > 0) return ms / 60000;
  }
  const coh = (sessionJson && sessionJson.streams && sessionJson.streams.coherence) || [];
  if (coh.length > 1) return Math.max(0, (coh[coh.length - 1].t - coh[0].t) / 60);
  return 0;
}

/**
 * Run interval analysis for a session against BOTH data sources (Joseph's
 * choice): the delivered cascade and the full 27-position library. Also scores
 * the session's duration against the dominant regime's protocol.
 *
 * @param {object} sessionJson - full session ({ metadata, streams })
 * @param {object} IA          - IntervalAnalysis API (window.IntervalAnalysis)
 * @param {Array}  frequencies - the 27-frequency library
 * @returns {{cascadePeaks:Array, libPeaks:Array, cascade:object, library:object,
 *           durationMinutes:number, duration:object, regime:string}}
 */
export function analyzeSession(sessionJson, IA, frequencies) {
  const cascadePeaks = extractPlayedPeaks(sessionJson);
  const libPeaks = libraryPeaks(frequencies);

  const cascade = IA.analyzeIntervals(cascadePeaks);
  const library = IA.analyzeIntervals(libPeaks);

  const minutes = sessionDurationMinutes(sessionJson);
  // Prefer the cascade's dominant regime; fall back to the library's, then GUT.
  const regime = cascade.summary.regime || library.summary.regime || 'GUT';
  const duration = IA.evaluateDuration(regime, +minutes.toFixed(1));

  return {
    cascadePeaks,
    libPeaks,
    cascade,
    library,
    durationMinutes: +minutes.toFixed(1),
    duration,
    regime,
  };
}

/**
 * Time series of cumulative cascade coherence: at each play event, the interval
 * coherence score of all distinct frequencies delivered up to that moment. This
 * is the "audio coherence over time" track that the EEG cross-correlation view
 * overlays against brain coherence (spec §App-2.4).
 *
 * @param {object} sessionJson
 * @param {object} IA
 * @returns {Array<{t:number,score:number,hz:number,count:number}>}
 */
export function cumulativeCascadeCoherence(sessionJson, IA) {
  const presc = (sessionJson && sessionJson.streams && sessionJson.streams.prescription) || [];
  const seen = new Set();
  const peaks = [];
  const series = [];
  for (const p of presc) {
    if (p.action !== 'play' || !Number.isFinite(p.freq) || p.freq <= 0) continue;
    if (!seen.has(p.freq)) { seen.add(p.freq); peaks.push({ hz: p.freq }); }
    const score = IA.analyzeIntervals(peaks).coherenceScore;
    series.push({ t: p.t, score, hz: p.freq, count: peaks.length });
  }
  return series;
}

/**
 * Compact, serialization-friendly block attached to session exports (mirrors
 * the RCT export shape from the spec, but carries both data sources).
 * @param {object} analysis - result of analyzeSession()
 * @returns {?object}
 */
export function buildIntervalExport(analysis) {
  if (!analysis) return null;
  const sumBlock = (a) => ({
    coherenceScore: a.summary.score,
    classification: a.summary.label,
    classificationIcon: a.summary.icon,
    ratio369: a.summary.ratio369,
    aetheriaIntervalCount: a.summary.aetheriaIntervalCount,
    harmonicRatioCount: a.summary.harmonicRatioCount,
    dominantRegime: a.summary.regime,
    totalIntervals: a.fingerprint.totalIntervals,
  });
  return {
    module_version: '1.0',
    cascade: sumBlock(analysis.cascade),
    library: sumBlock(analysis.library),
    peaksAnalyzed: analysis.cascadePeaks.map(p => p.hz),
    duration: {
      actualMinutes: analysis.durationMinutes,
      regime: analysis.regime,
      status: analysis.duration.status,
      met: analysis.duration.met,
      protocol: analysis.duration.protocol,
      label: analysis.duration.label,
    },
  };
}
