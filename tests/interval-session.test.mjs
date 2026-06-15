// Tests for the Coherence Lab interval-session glue (ESM helpers) and the
// end-to-end attach → export path that rides interval analysis along with a
// session's full + tagger exports.
//
// Run: node tests/interval-session.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  isPrime,
  extractPlayedPeaks,
  libraryPeaks,
  sessionDurationMinutes,
  analyzeSession,
  cumulativeCascadeCoherence,
  buildIntervalExport,
} from '../src/coherence/interval-session.js';
import { buildTaggerExport } from '../src/recording/tagger-export.js';
import { generateReport } from '../src/recording/session-report.js';

const require = createRequire(import.meta.url);
const IA = require('../src/lib/interval-analysis.js');

const here = dirname(fileURLToPath(import.meta.url));
const frequencies = JSON.parse(readFileSync(resolve(here, '../src/config/frequencies.json'), 'utf8'));

console.log('interval-session.test.mjs');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

// ---------- synthetic session: GUT seed cascade over ~45 minutes ----------
function makeSession() {
  const startTime = '2026-05-01T10:00:00.000Z';
  const endTime = '2026-05-01T10:45:00.000Z'; // 45 min → optimal for GUT
  return {
    metadata: { sessionId: 's1', userId: 'u1', startTime, endTime, softwareVersion: '1.0.0' },
    streams: {
      // Match the recorder's coherence-sample shape (incl. plv/harm/deficit/lead).
      coherence: [
        { t: 0, tcs: 40, gut: 0.4, heart: 0.4, head: 0.4, plv: 0.3, harm: 0.4, deficit: 'GUT', lead: 'HEART' },
        { t: 1200, tcs: 70, gut: 0.7, heart: 0.6, head: 0.65, plv: 0.5, harm: 0.6, deficit: 'NONE', lead: 'GUT' },
        { t: 2700, tcs: 82, gut: 0.8, heart: 0.75, head: 0.78, plv: 0.6, harm: 0.7, deficit: 'NONE', lead: 'GUT' },
      ],
      prescription: [
        { t: 10, action: 'play', freq: 174, regime: 'GUT', name: 'Foundation' },
        { t: 400, action: 'play', freq: 285, regime: 'GUT', name: 'Quantum Cognition' },
        { t: 800, action: 'play', freq: 396, regime: 'GUT', name: 'Liberation' },
        { t: 1200, action: 'play', freq: 528, regime: 'GUT', name: 'Transformation' },
        { t: 1600, action: 'stop', freq: 528, regime: 'GUT', name: 'Transformation' },
        { t: 1700, action: 'play', freq: 528, regime: 'GUT', name: 'Transformation' }, // dup → dedup
      ],
    },
  };
}

// ---------- isPrime ----------
test('isPrime basic cases', () => {
  assert.equal(isPrime(2), true);
  assert.equal(isPrime(3), true);
  assert.equal(isPrime(174), false);   // 2·3·29
  assert.equal(isPrime(528), false);
  assert.equal(isPrime(523), true);
  assert.equal(isPrime(1), false);
});

// ---------- extractPlayedPeaks ----------
test('extractPlayedPeaks dedups and keeps first-played order', () => {
  const peaks = extractPlayedPeaks(makeSession());
  assert.deepEqual(peaks.map(p => p.hz), [174, 285, 396, 528]);
  assert.equal(peaks[0].regime, 'GUT');
});

test('libraryPeaks returns all 27 positions', () => {
  const peaks = libraryPeaks(frequencies);
  assert.equal(peaks.length, 27);
  assert.ok(peaks.every(p => Number.isFinite(p.hz)));
});

// ---------- sessionDurationMinutes ----------
test('sessionDurationMinutes from ISO metadata', () => {
  assert.equal(sessionDurationMinutes(makeSession()), 45);
});

test('sessionDurationMinutes falls back to coherence span', () => {
  const s = makeSession();
  delete s.metadata.startTime;
  assert.equal(sessionDurationMinutes(s), 2700 / 60);
});

// ---------- analyzeSession ----------
test('analyzeSession scores cascade + library and evaluates duration', () => {
  const a = analyzeSession(makeSession(), IA, frequencies);
  assert.ok(a.cascade.summary.score > 0, 'cascade score > 0');
  assert.ok(a.library.summary.score > 0, 'library score > 0');
  assert.equal(a.durationMinutes, 45);
  assert.equal(a.regime, 'GUT');
  assert.equal(a.duration.status, 'optimal');  // 45 min within GUT 40-60
  assert.equal(a.duration.met, true);
});

// ---------- cumulativeCascadeCoherence ----------
test('cumulativeCascadeCoherence grows one entry per distinct play', () => {
  const series = cumulativeCascadeCoherence(makeSession(), IA);
  // 4 distinct plays + 1 dup that re-emits a point = 5 entries; counts cap at 4
  assert.ok(series.length >= 4);
  assert.equal(series[series.length - 1].count, 4);
  assert.ok(series.every(p => p.score >= 0 && p.score <= 100));
});

// ---------- buildIntervalExport ----------
test('buildIntervalExport produces a compact serializable block', () => {
  const a = analyzeSession(makeSession(), IA, frequencies);
  const block = buildIntervalExport(a);
  assert.ok(block.cascade && block.library && block.duration);
  assert.equal(typeof block.cascade.coherenceScore, 'number');
  assert.deepEqual(block.peaksAnalyzed, [174, 285, 396, 528]);
  // round-trips through JSON unchanged
  assert.deepEqual(JSON.parse(JSON.stringify(block)), block);
});

// ---------- export integration ----------
test('tagger export carries interval_analysis when attached', () => {
  const session = makeSession();
  session.intervalAnalysis = buildIntervalExport(analyzeSession(session, IA, frequencies));
  const tagger = buildTaggerExport(session);
  assert.ok(tagger.interval_analysis, 'interval_analysis block present');
  assert.equal(typeof tagger.summary.interval_coherence_score, 'number');
  assert.equal(tagger.summary.interval_dominant_regime, 'GUT');
  assert.equal(tagger.summary.duration_minutes, 45);
  assert.equal(tagger.summary.duration_protocol_met, true);
});

test('tagger export stays back-compatible when interval_analysis absent', () => {
  const tagger = buildTaggerExport(makeSession());
  assert.equal(tagger.interval_analysis, null);
  assert.equal(tagger.summary.interval_coherence_score, null);
  assert.equal(tagger.summary.duration_minutes, null);
});

test('session report passes interval analysis through', () => {
  const session = makeSession();
  session.intervalAnalysis = buildIntervalExport(analyzeSession(session, IA, frequencies));
  const report = generateReport(session);
  assert.ok(report.intervalAnalysis, 'report.intervalAnalysis present');
  const bare = generateReport(makeSession());
  assert.equal(bare.intervalAnalysis, null);
});

console.log();
if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('all interval-session tests passed');
