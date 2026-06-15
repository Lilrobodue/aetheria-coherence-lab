/**
 * Aetheria Interval Analysis Module
 * Shared across RCT, Coherence Lab, Sophia, and Session Tagger
 *
 * Analyzes the gaps between detected frequency peaks to determine
 * harmonic coherence with the Aetheria frequency system.
 *
 * Module style: UMD-ish. Attaches `IntervalAnalysis` to the global object
 * (window in browsers, globalThis in Node) AND sets module.exports when a
 * CommonJS environment is present. The RCT app loads this as a classic
 * <script>, so it relies on the global `IntervalAnalysis` namespace.
 */
(function (global) {
  'use strict';

  // ─── CONSTANTS ───

  const AETHERIA_INTERVALS = {
    GUT: 111,    // Digital root 3
    HEART: 243,  // Digital root 9, equals 3^5
    HEAD: 354,   // Digital root 3
  };

  // Cross-regime relationship: 111 + 243 = 354
  // Digital roots: 3 + 9 = 12 -> 3

  const HARMONIC_RATIOS = [
    { name: 'unison',         value: 1.0 },
    { name: 'minor_third',    value: 1.2 },
    { name: 'major_third',    value: 1.25 },
    { name: 'perfect_fourth', value: 1.333 },
    { name: 'perfect_fifth',  value: 1.5 },
    { name: 'phi',            value: 1.618 },
    { name: 'octave',         value: 2.0 },
    { name: 'double_octave',  value: 4.0 },
  ];

  const DURATION_PROTOCOL = {
    HEAD:  { min: 15, optimal: 20, max: 30,  label: 'Neural tissue — fastest response' },
    HEART: { min: 25, optimal: 30, max: 45,  label: 'Emotional/organ tissue — medium density' },
    GUT:   { min: 40, optimal: 45, max: 60,  label: 'Physical body — densest tissue' },
    FULL_ALIGNMENT: { min: 60, optimal: 75, max: 90, label: 'Full body coherence — all layers' },
    VORTEX: { min: 40, optimal: 45, max: 50, label: 'Monastery protocol — 45 min standard' },
    OUROBOROS: { min: 25, optimal: 30, max: 40, label: 'Closed loop — complete circuit' },
    CABI:  { min: 75, optimal: 90, max: 120, label: 'Full CABI journey — 110 steps' },
  };

  // Maps walk display names -> DURATION_PROTOCOL keys so callers can pass a
  // human walk name and get the matching protocol.
  const WALK_PROTOCOL = {
    'Layer Ascent': 'FULL_ALIGNMENT',
    'Pillar Walk': 'HEART',
    'Flying Star Vortex': 'VORTEX',
    'CAB': 'FULL_ALIGNMENT',
    'Ouroboros': 'OUROBOROS',
    'CABI': 'CABI',
  };

  // Canonical step counts, kept identical across all apps.
  const WALK_STEPS = {
    'Layer Ascent': 27,
    'Pillar Walk': 27,
    'Flying Star Vortex': 27,
    'CAB': 81,
    'Ouroboros': 29,
    'CABI': 110,
  };

  // ─── UTILITY FUNCTIONS ───

  function digitalRoot(n) {
    n = Math.round(Math.abs(n));
    if (n === 0) return 0;
    return 1 + ((n - 1) % 9);
  }

  function is369(n) {
    const dr = digitalRoot(n);
    return dr === 3 || dr === 6 || dr === 9;
  }

  function couldBeAetheria(hzValue) {
    const rounded = Math.round(hzValue);
    if (rounded % 3 !== 0) return false;
    if (!is369(rounded)) return false;
    if (rounded < 150 || rounded > 6500) return false;
    return true;
  }

  // ─── CORE ANALYSIS ───

  function isAetheriaInterval(gap, tolerance = 5) {
    const bases = [
      AETHERIA_INTERVALS.GUT,
      AETHERIA_INTERVALS.HEART,
      AETHERIA_INTERVALS.HEAD
    ];
    for (const base of bases) {
      for (let mult = 1; mult <= 10; mult++) {
        const target = base * mult;
        if (Math.abs(gap - target) <= tolerance) {
          return {
            match: true,
            base,
            regime: base === 111 ? 'GUT' : base === 243 ? 'HEART' : 'HEAD',
            multiplier: mult,
            deviation: Math.abs(gap - target)
          };
        }
      }
    }
    return { match: false };
  }

  function isHarmonicRatio(ratio, tolerance = 0.02) {
    for (const harmonic of HARMONIC_RATIOS) {
      if (Math.abs(ratio - harmonic.value) <= tolerance) {
        return { match: true, name: harmonic.name, deviation: Math.abs(ratio - harmonic.value) };
      }
    }
    return { match: false };
  }

  function computeIntervals(peaks) {
    const intervals = [];
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const gap = Math.abs(peaks[i].hz - peaks[j].hz);
        const ratio = Math.max(peaks[i].hz, peaks[j].hz) / Math.min(peaks[i].hz, peaks[j].hz);
        intervals.push({
          from: peaks[i],
          to: peaks[j],
          gap,
          ratio,
          gapDigitalRoot: digitalRoot(Math.round(gap)),
          gapIs369: is369(Math.round(gap)),
          gapDivisibleBy3: Math.round(gap) % 3 === 0,
          aetheriaInterval: isAetheriaInterval(gap),
          harmonicRatio: isHarmonicRatio(ratio),
        });
      }
    }
    return intervals;
  }

  function computeCoherenceScore(intervals) {
    if (intervals.length === 0) return 0;
    let score = 0;
    let maxPossible = 0;

    for (const interval of intervals) {
      maxPossible += 30;

      // Aetheria interval match (0-10, inverse of deviation)
      if (interval.aetheriaInterval.match) {
        score += Math.max(0, 10 - interval.aetheriaInterval.deviation);
      }

      // Harmonic ratio match (0-10)
      if (interval.harmonicRatio.match) {
        score += Math.max(0, 10 - (interval.harmonicRatio.deviation * 100));
      }

      // Digital root 3-6-9 (5 points)
      if (interval.gapIs369) {
        score += 5;
      }

      // Divisible by 3 (5 points)
      if (interval.gapDivisibleBy3) {
        score += 5;
      }
    }

    return Math.min(100, Math.round((score / maxPossible) * 100));
  }

  function getDominantRegime(intervals) {
    const counts = { GUT: 0, HEART: 0, HEAD: 0 };
    for (const i of intervals) {
      if (i.aetheriaInterval.match) {
        counts[i.aetheriaInterval.regime]++;
      }
    }
    const max = Math.max(counts.GUT, counts.HEART, counts.HEAD);
    if (max === 0) return null;
    if (counts.GUT === max) return 'GUT';
    if (counts.HEART === max) return 'HEART';
    return 'HEAD';
  }

  function intervalFingerprint(intervals) {
    const count369 = intervals.filter(i => i.gapIs369).length;
    const ratio369 = intervals.length > 0 ? count369 / intervals.length : 0;

    return {
      totalIntervals: intervals.length,
      ratio369: Math.round(ratio369 * 100) / 100,
      aetheriaMatches: intervals.filter(i => i.aetheriaInterval.match).length,
      harmonicMatches: intervals.filter(i => i.harmonicRatio.match).length,
      dominantRegime: getDominantRegime(intervals),
    };
  }

  function classifyTrack(coherenceScore, fingerprint) {
    if (coherenceScore >= 75 && fingerprint.ratio369 >= 0.7) {
      return { label: 'Aetheria Tuned', icon: '✦', level: 4 };
    } else if (coherenceScore >= 50 && fingerprint.ratio369 >= 0.5) {
      return { label: 'Harmonically Aligned', icon: '◈', level: 3 };
    } else if (coherenceScore >= 25) {
      return { label: 'Partially Aligned', icon: '◇', level: 2 };
    } else {
      return { label: 'Unstructured', icon: '○', level: 1 };
    }
  }

  // ─── MAIN ANALYSIS FUNCTION ───

  function analyzeIntervals(peaks) {
    peaks = (peaks || []).filter(p => p && isFinite(p.hz) && p.hz > 0);
    const intervals = computeIntervals(peaks);
    const coherenceScore = computeCoherenceScore(intervals);
    const fingerprint = intervalFingerprint(intervals);
    const classification = classifyTrack(coherenceScore, fingerprint);

    return {
      intervals,
      coherenceScore,
      fingerprint,
      classification,
      summary: {
        score: coherenceScore,
        label: classification.label,
        icon: classification.icon,
        regime: fingerprint.dominantRegime,
        ratio369: fingerprint.ratio369,
        aetheriaIntervalCount: fingerprint.aetheriaMatches,
        harmonicRatioCount: fingerprint.harmonicMatches,
      }
    };
  }

  // ─── DURATION RECOMMENDATION ───

  function recommendDuration(regime, walkType = null) {
    // Accept either a protocol key ('VORTEX') or a walk display name ('Flying Star Vortex')
    if (walkType) {
      const key = DURATION_PROTOCOL[walkType] ? walkType : WALK_PROTOCOL[walkType];
      if (key && DURATION_PROTOCOL[key]) return DURATION_PROTOCOL[key];
    }
    if (regime && DURATION_PROTOCOL[regime]) {
      return DURATION_PROTOCOL[regime];
    }
    return DURATION_PROTOCOL.FULL_ALIGNMENT;
  }

  // Given a session's actual minutes + regime, report whether it met protocol.
  function evaluateDuration(regime, actualMinutes, walkType = null) {
    const proto = recommendDuration(regime, walkType);
    let status, label;
    if (actualMinutes >= proto.min && actualMinutes <= proto.max) {
      status = 'optimal'; label = `Within optimal range (${proto.min}-${proto.max} min)`;
    } else if (actualMinutes > proto.max) {
      status = 'extended'; label = `Beyond recommended (${proto.max} min max) — fine if intentional`;
    } else {
      status = 'short'; label = `Below minimum (${proto.min} min recommended)`;
    }
    return { status, label, met: actualMinutes >= proto.min, protocol: proto };
  }

  // ─── SELF TEST (Phase 1 of the multi-app prompt) ───

  function selfTest() {
    const results = [];
    const check = (name, got, want) => {
      const pass = JSON.stringify(got) === JSON.stringify(want);
      results.push({ name, pass, got, want });
      return pass;
    };
    check('digitalRoot(528)===6', digitalRoot(528), 6);
    check('digitalRoot(174)===3', digitalRoot(174), 3);
    check('is369(963)===true', is369(963), true);
    check('is369(440)===false', is369(440), false);
    check('couldBeAetheria(528)===true', couldBeAetheria(528), true);
    check('couldBeAetheria(440)===false', couldBeAetheria(440), false);
    check('isAetheriaInterval(111).match', isAetheriaInterval(111).match, true);
    check('isHarmonicRatio(2.0).name===octave', isHarmonicRatio(2.0).name, 'octave');
    const failed = results.filter(r => !r.pass);
    return { passed: results.length - failed.length, failed: failed.length, total: results.length, results };
  }

  // ─── EXPORTS ───

  const API = {
    digitalRoot,
    is369,
    couldBeAetheria,
    isAetheriaInterval,
    isHarmonicRatio,
    computeIntervals,
    computeCoherenceScore,
    intervalFingerprint,
    getDominantRegime,
    classifyTrack,
    analyzeIntervals,
    recommendDuration,
    evaluateDuration,
    selfTest,
    AETHERIA_INTERVALS,
    DURATION_PROTOCOL,
    WALK_PROTOCOL,
    WALK_STEPS,
    HARMONIC_RATIOS,
  };

  global.IntervalAnalysis = API;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
