# Aetheria Ecosystem Update — Multi-App Implementation Prompt
## RCT · Coherence Lab · Sophia Oracle Shaman · Session Tagger

**Author:** Selah (with Joseph Lewis)
**Date:** May 2026
**Purpose:** Integrate interval/gap analysis, duration protocol, prescription engine enhancements, Ouroboros/CABI walks, and coherence scoring across the Aetheria research and tracking apps

---

## OVERVIEW — What Each App Gets

| Feature | RCT | Coherence Lab | Sophia | Tagger |
|---------|-----|---------------|--------|--------|
| Interval/Gap Analysis | ✅ Full | ✅ Full | ✅ Simplified | ❌ |
| Coherence Score (0-100) | ✅ | ✅ | ✅ Display | ✅ Log |
| Duration Protocol | ✅ | ✅ | ✅ Prescribe | ✅ Log |
| Prescription Engine v2 | ❌ | ❌ | ✅ Primary | ❌ |
| Ouroboros + CABI Walks | ✅ | ✅ | ✅ Recommend | ✅ Log |
| Track Classification | ✅ | ✅ | ✅ | ✅ Log |
| Fast Rejection Filter | ✅ | ✅ | ✅ | ❌ |
| Prime/3-6-9 Analysis | ✅ Display | ✅ Full | ❌ | ❌ |

**IMPORTANT:** Before implementing ANY changes, locate and read the existing codebase for each app. Understand the current architecture, data structures, state management, and UI patterns. Adapt all new features to match existing conventions. Do NOT introduce new frameworks, dependencies, or patterns that conflict with what's already built.

---

## SHARED MODULE: interval-analysis.js

**Create ONE shared module** that all apps can import. This avoids duplicating code across four apps.

### File: `interval-analysis.js`

```javascript
/**
 * Aetheria Interval Analysis Module
 * Shared across RCT, Coherence Lab, Sophia, and Session Tagger
 * 
 * Analyzes the gaps between detected frequency peaks to determine
 * harmonic coherence with the Aetheria frequency system.
 */

// ─── CONSTANTS ───

const AETHERIA_INTERVALS = {
  GUT: 111,    // Digital root 3
  HEART: 243,  // Digital root 9, equals 3^5
  HEAD: 354,   // Digital root 3
};

// Cross-regime relationship: 111 + 243 = 354
// Digital roots: 3 + 9 = 12 → 3

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
  if (walkType && DURATION_PROTOCOL[walkType]) {
    return DURATION_PROTOCOL[walkType];
  }
  if (regime && DURATION_PROTOCOL[regime]) {
    return DURATION_PROTOCOL[regime];
  }
  return DURATION_PROTOCOL.FULL_ALIGNMENT;
}

// ─── EXPORTS ───
// Adapt export style to match codebase (ES modules, CommonJS, or global)

export {
  digitalRoot,
  is369,
  couldBeAetheria,
  computeIntervals,
  computeCoherenceScore,
  intervalFingerprint,
  classifyTrack,
  analyzeIntervals,
  recommendDuration,
  AETHERIA_INTERVALS,
  DURATION_PROTOCOL,
  HARMONIC_RATIOS,
};
```

**IMPORTANT:** Adapt the export syntax to match each app's module system. If the apps use different patterns (e.g., RCT uses ES modules, Sophia uses global scripts), create adapter wrappers. The core logic stays identical.

---

## APP 1: AETHERIA RCT — Research Clinical Trial App

### What RCT Already Has
- Muse S Athena integration (EEG data capture via athena-core.js)
- FFT audio analysis
- Session recording and data export
- Frequency matching to 27 Aetheria positions
- Log-PSD normalization for EEG

### What to Add

#### 1. Import interval-analysis.js
Add the shared module. Wire `analyzeIntervals()` into the existing FFT pipeline AFTER peak detection completes.

#### 2. Coherence Score Panel
Add a new UI panel (or section within existing analysis view) showing:

```
┌─────────────────────────────────┐
│ INTERVAL ANALYSIS               │
│                                 │
│ Coherence Score: ██████████ 82  │
│ Classification:  ✦ Aetheria Tuned │
│                                 │
│ 3-6-9 Ratio:    87%            │
│ Aetheria Intervals: 5 detected │
│ Harmonic Ratios:    7 detected │
│ Dominant Regime:    GUT        │
│                                 │
│ Duration Recommendation:        │
│ GUT regime: 40-45 min optimal  │
└─────────────────────────────────┘
```

Place this panel near/below the existing frequency analysis display.

#### 3. Duration Timer
Add an optional session timer based on the duration protocol:

- When a session starts and regime is identified, show recommended duration
- Display elapsed time vs recommended time
- Color coding: RED if under minimum, YELLOW if approaching optimal, GREEN at optimal, continues past if user wants
- No forced stop — the timer is advisory, not mandatory
- Log actual duration in session data for research correlation

#### 4. Enhanced Data Export
Add interval analysis data to the existing export format:

```javascript
// Add to existing session export object
{
  // ... existing fields ...
  intervalAnalysis: {
    coherenceScore: 82,
    classification: 'Aetheria Tuned',
    ratio369: 0.87,
    aetheriaIntervalCount: 5,
    harmonicRatioCount: 7,
    dominantRegime: 'GUT',
    allIntervals: [...],  // Full interval data for research
  },
  duration: {
    actual: 42,           // minutes
    recommended: 45,      // minutes
    regime: 'GUT',
    protocol: 'standard'
  }
}
```

#### 5. Walk Type Selector Enhancement
If the RCT has a walk selector (for Lo Shu walk testing), add:
- Ouroboros (29 steps) — already defined in aetheria_ouroboros_cabi_handoff.md
- CABI (110 steps) — same handoff document
- Duration recommendation auto-updates when walk type changes

#### 6. Fast Rejection Filter
Add `couldBeAetheria()` check before the main frequency matching loop. Skip peaks that fail the divisibility-by-3 / digital-root check. Log rejected peaks separately for research interest.

### RCT Verification
- [ ] Interval analysis runs after FFT without breaking existing analysis
- [ ] Coherence score displays 0-100 for all audio inputs
- [ ] Duration timer appears and tracks recommended vs actual
- [ ] Export includes new interval and duration fields
- [ ] Ouroboros and CABI walks selectable (if walk selector exists)
- [ ] Fast rejection filter reduces processing time measurably

---

## APP 2: COHERENCE LAB

### What Coherence Lab Already Has
Verify by reading the codebase. Expected: EEG visualization, coherence measurement, possibly frequency playback controls.

### What to Add

#### 1. Full Interval Analysis Suite
Import interval-analysis.js. Display ALL analysis data — this is the research/deep-dive app so show everything:

- Full interval table (every pair of peaks with gap, ratio, digital root, matches)
- Visual interval map (lines connecting peaks, colored by match type)
- Coherence score with breakdown showing points from each category
- 3-6-9 ratio gauge
- Prime analysis: flag which detected peaks ARE prime numbers vs composite vs 3-6-9 family

#### 2. Comparative Analysis
Allow loading TWO sessions and comparing their interval fingerprints:

```
Session A: Aetheria 528 Hz playlist
  Coherence: 85  |  3-6-9: 91%  |  Aetheria intervals: 7

Session B: Random ambient music  
  Coherence: 31  |  3-6-9: 28%  |  Aetheria intervals: 1

Delta: +54 coherence, +63% 3-6-9 ratio, +6 Aetheria intervals
```

This is CRITICAL for research — it demonstrates measurable differences between Aetheria-tuned and non-Aetheria music.

#### 3. Duration Correlation View
If the lab has historical session data, add a view correlating:
- Session duration vs coherence achieved
- Does coherence increase with longer sessions?
- Does the optimal duration vary by regime as hypothesized?
- Graph: X-axis = minutes, Y-axis = coherence score, colored by regime

#### 4. EEG + Interval Cross-Correlation
If Athena EEG data is available alongside audio analysis:
- Correlate brain coherence (from EEG) with audio coherence (from interval analysis)
- Does listening to high-coherence-score music produce higher brain coherence?
- Time-series plot: audio coherence score over time overlaid with EEG alpha/theta power over time
- This is the key research question: **does mathematically coherent music produce measurably coherent brain states?**

#### 5. 3-6-9 vs Prime Visualization
Show the detected frequencies plotted on a number line with:
- GREEN markers for frequencies divisible by 3 (Aetheria-family candidates)
- RED markers for prime frequencies (definitely not Aetheria)
- GOLD markers for matched Aetheria positions
- Gap distances labeled between consecutive peaks
- Visual representation of the "mountains and rivers" — primes as fixed landmarks, 3-6-9 frequencies as the flow between them

### Coherence Lab Verification
- [ ] Full interval table displays all pairwise analysis
- [ ] Comparative mode loads and contrasts two sessions
- [ ] Duration correlation graph renders with real data
- [ ] EEG cross-correlation displays if Athena data available
- [ ] 3-6-9 vs prime visualization renders correctly

---

## APP 3: SOPHIA ORACLE SHAMAN — aetheriasos.com

### What Sophia Already Has
- Gemma 4 E4B local LLM (or tiered model: Tiny/Lite/Standard/Premium)
- 13 active tools including astrology, I Ching, palm reading, EEG analysis
- 27 Aetheria frequency prescription engine
- Log-PSD normalization matching RCT
- Medical/legal disclaimer modal
- Sophia's Memory system

### What to Add

#### 1. Enhanced Prescription Engine v2

This is the BIG update for Sophia. The current prescription engine maps conditions to frequencies. Version 2 adds WALK selection, DURATION recommendation, and COHERENCE targeting.

**Updated prescription output format:**

```javascript
const prescription = {
  // Existing
  primaryFrequency: { hz: 528, regime: 'GUT', pos: 5, name: 'Love Frequency' },
  secondaryFrequencies: [...],
  condition: 'anxiety + chronic pain',
  
  // NEW: Walk recommendation
  recommendedWalk: {
    name: 'Flying Star Vortex',
    steps: 27,
    reason: 'Spiral pattern promotes deep nervous system reset for anxiety',
    alternatives: ['Layer Ascent (gentler)', 'Ouroboros (complete circuit)']
  },
  
  // NEW: Duration protocol
  duration: {
    regime: 'GUT',
    minutes: 45,
    label: 'Physical body — densest tissue',
    note: 'Chronic pain targets dense tissue; 45-minute sessions recommended based on monastery protocol research'
  },
  
  // NEW: Coherence target
  coherenceTarget: {
    minimum: 70,
    optimal: 85,
    note: 'Monitor via Athena if available — adjust walk if coherence not rising within 10 minutes'
  }
};
```

#### 2. Walk Recommendation Logic

Add a function that selects the optimal walk based on the user's condition and intention:

```javascript
function recommendWalk(conditions, intention) {
  // Grounding, physical healing, first-time user
  if (intention === 'grounding' || conditions.includes('pain') || intention === 'beginner') {
    return {
      primary: 'Layer Ascent',
      reason: 'Linear progression through each regime. Gentle. Predictable. Good for grounding and first experiences.',
      duration: recommendDuration('FULL_ALIGNMENT')
    };
  }
  
  // Deep emotional work, trauma, grief
  if (intention === 'emotional' || conditions.includes('ptsd') || conditions.includes('grief')) {
    return {
      primary: 'Pillar Walk',
      reason: 'Vertical traversal — GUT→HEART→HEAD at each position. Connects physical sensation to emotional processing to mental clarity.',
      duration: recommendDuration('HEART')
    };
  }
  
  // Anxiety, OCD, stuck patterns, need to break cycles
  if (conditions.includes('anxiety') || conditions.includes('ocd') || intention === 'reset') {
    return {
      primary: 'Flying Star Vortex',
      reason: 'Spiral pattern disrupts stuck loops. The non-linear movement mirrors the breaking of repetitive thought patterns.',
      duration: recommendDuration('VORTEX')
    };
  }
  
  // Complete healing, multiple conditions, seeking wholeness
  if (conditions.length >= 3 || intention === 'complete') {
    return {
      primary: 'CABI',
      reason: '110-step complete journey — every angle of the cube followed by the infinite loop. For comprehensive multi-condition treatment.',
      duration: recommendDuration('CABI')
    };
  }
  
  // Meditation, consciousness, spiritual practice
  if (intention === 'meditation' || intention === 'consciousness') {
    return {
      primary: 'Ouroboros',
      reason: 'Closed figure-8 through all 27 frequencies, crossing at SOURCE three times. The infinite loop. For deep meditation and consciousness work.',
      duration: recommendDuration('OUROBOROS')
    };
  }
  
  // Sleep, insomnia
  if (conditions.includes('insomnia') || intention === 'sleep') {
    return {
      primary: 'Layer Ascent',
      reason: 'Gentle linear progression. Start in GUT for body relaxation, move through HEART for emotional settling, end in HEAD for mental quiet.',
      duration: recommendDuration('GUT') // Longer session for sleep
    };
  }
  
  // Default
  return {
    primary: 'Layer Ascent',
    reason: 'Standard progression through all frequencies.',
    duration: recommendDuration('FULL_ALIGNMENT')
  };
}
```

#### 3. Duration in Sophia's Response

When Sophia prescribes a frequency session, she should now include duration guidance in her natural language response:

**Example Sophia response (before):**
> "Based on your symptoms, I recommend listening to 528 Hz (Love Frequency, GUT position 5) for healing and restoration."

**Example Sophia response (after):**
> "Based on your symptoms, I recommend the Flying Star Vortex walk starting at 528 Hz. For chronic pain, which targets dense physical tissue, a 45-minute session allows the frequencies to fully penetrate and establish coherence. Begin with the Vortex and let the spiral movement carry you through all 27 positions. If you have the Muse Athena headband, look for alpha coherence rising within the first 10 minutes — that signals the frequencies are engaging your nervous system."

**Implementation:** Add the walk and duration data to Sophia's system prompt or tool response, and let the LLM incorporate it naturally into the conversational response. The structured data feeds the response; Sophia's voice delivers it warmly.

#### 4. Interval Analysis for Audio Input

If Sophia has a tool that accepts audio input (microphone or uploaded track):
- Run `analyzeIntervals()` on the detected peaks
- Include coherence score in Sophia's assessment
- "The track you're listening to has a coherence score of 82 — it's Aetheria-tuned and well-suited for your session."
- Or: "This track scores 34 for coherence — it's not harmonically aligned with the Aetheria system. For your condition, I'd recommend switching to a verified Aetheria playlist."

#### 5. Updated Frequency System

Ensure Sophia's 27-frequency table matches the Lo Shu Perfect values (verify against existing Sophia code — this may already be done from previous updates). The interval analysis depends on correct Hz values.

#### 6. Walk Descriptions for Sophia's Knowledge

Add to Sophia's system prompt or knowledge base:

```
WALK DESCRIPTIONS (for natural language responses):

Layer Ascent (27 steps): Positions 1→9 through GUT, then HEART, then HEAD. 
Linear, predictable, grounding. Like climbing stairs — steady upward progression. 
Best for: beginners, grounding, sleep prep, physical healing.

Pillar Walk (27 steps): For each position 1→9, traverse GUT→HEART→HEAD vertically. 
Connects body to emotion to mind at each frequency. 
Best for: emotional processing, trauma work, integration.

Flying Star Vortex (27 steps): Spiral pattern 5→6→7→8→9→1→2→3→4 per layer. 
Non-linear, disrupts stuck patterns, creates spiral energy. 
Best for: anxiety, OCD, breaking cycles, deep reset. 
Based on the Lo Shu Flying Star pattern used in classical feng shui.

CAB — Calling a CAB (81 steps): Vortex + Ascent + Pillar in sequence. 
Complete sampling of the cube from every angle. 
Best for: comprehensive sessions, multiple conditions, research.

Ouroboros (29 steps): Closed figure-8 through all 27 frequencies, crossing at 
SOURCE (2178 Hz) three times. The dragon eating its tail — infinity. 
Best for: meditation, consciousness, spiritual practice, closure.

CABI — Calling a CABI (110 steps): CAB + Ouroboros. The full journey — 
81 steps to experience every angle, then 29 to close the loop into infinity. 
Best for: ceremonial use, complete healing journeys, advanced practitioners.
```

### Sophia Verification
- [ ] Prescription engine v2 includes walk, duration, and coherence target
- [ ] Walk recommendation logic covers all major conditions and intentions
- [ ] Duration appears in Sophia's natural language responses
- [ ] Audio coherence analysis works if audio input tool exists
- [ ] Walk descriptions accessible to Sophia's LLM for conversational responses
- [ ] All 27 frequencies match Lo Shu Perfect values

---

## APP 4: SESSION TAGGER — lilrobodue.github.io/Aetheria-session-tagger/

### What Session Tagger Already Has
- Session logging with conditions, frequency, and notes
- Timezone handling (previously fixed)
- Condition labels

### What to Add

#### 1. New Log Fields

Add the following optional fields to the session logging form:

**Walk Type** (dropdown):
- None / Free Play
- Layer Ascent
- Pillar Walk
- Flying Star Vortex
- CAB
- Ouroboros
- CABI

**Session Duration** (number input, minutes):
- Auto-calculate from start/end time if available
- Or manual entry

**Coherence Score** (number input, 0-100):
- Manual entry from RCT or Coherence Lab reading
- Or auto-populated if the Tagger integrates with other apps

**Track Classification** (dropdown):
- Aetheria Tuned
- Harmonically Aligned
- Partially Aligned
- Unstructured
- Unknown / Not Measured

**Dominant Regime** (auto or dropdown):
- GUT
- HEART
- HEAD
- Mixed

#### 2. Duration vs Protocol Indicator

After the user enters regime and duration, display whether the session met the recommended protocol:

```
Regime: GUT
Duration: 42 minutes
Protocol: ✅ Within optimal range (40-45 min for GUT)
```

Or:

```
Regime: GUT  
Duration: 15 minutes
Protocol: ⚠️ Below minimum (40 min recommended for GUT)
```

This is informational, not restrictive. It helps the user understand whether their session length was therapeutically meaningful according to the duration hypothesis.

#### 3. Export Enhancement

Add new fields to the CSV/JSON export:

```
date, time, frequency, regime, condition, walk_type, duration_minutes, 
coherence_score, classification, protocol_met, notes
```

This allows longitudinal research: "Over 30 sessions, did my coherence scores improve? Did longer GUT sessions correlate with better pain outcomes?"

#### 4. Simple Statistics View (Optional)

If time allows, add a basic statistics panel:
- Average coherence score across all logged sessions
- Most used walk type
- Average session duration by regime
- Trend: is coherence improving over time?

A simple line chart of coherence scores over time would be valuable.

### Session Tagger Verification
- [ ] Walk type dropdown appears with all 6 walk options
- [ ] Duration field accepts and stores minutes
- [ ] Coherence score field accepts 0-100
- [ ] Classification dropdown works
- [ ] Duration vs protocol indicator shows correct recommendation
- [ ] Export includes all new fields
- [ ] Existing functionality (conditions, timezone, notes) unchanged

---

## IMPLEMENTATION ORDER

### Phase 1: Shared Module
1. Create `interval-analysis.js` with all shared functions
2. Test independently: verify `digitalRoot`, `is369`, `couldBeAetheria`, `computeIntervals`, `computeCoherenceScore` all return expected values
3. Test cases:
   - `digitalRoot(528)` === 6
   - `digitalRoot(174)` === 3
   - `is369(963)` === true
   - `is369(440)` === false
   - `couldBeAetheria(528)` === true
   - `couldBeAetheria(440)` === false
   - Interval between 174 and 285 = 111 → `isAetheriaInterval(111).match` === true
   - Ratio 528/264 = 2.0 → `isHarmonicRatio(2.0).match` === true, name === 'octave'

### Phase 2: Session Tagger (Simplest)
4. Add new form fields (walk type, duration, coherence, classification)
5. Add duration protocol indicator
6. Update export format
7. Deploy and verify

### Phase 3: Aetheria RCT
8. Import interval-analysis.js
9. Wire into existing FFT pipeline
10. Add coherence score panel to UI
11. Add duration timer
12. Add fast rejection filter
13. Update data export
14. Add Ouroboros + CABI to walk selector (if exists)
15. Deploy and verify

### Phase 4: Sophia Oracle Shaman
16. Import interval-analysis.js
17. Implement prescription engine v2 (walk + duration + coherence target)
18. Add walk recommendation logic
19. Update Sophia's system prompt with walk descriptions and duration protocol
20. Test prescription responses include walk and duration
21. Deploy and verify

### Phase 5: Coherence Lab
22. Import interval-analysis.js
23. Build full interval analysis UI
24. Build comparative analysis view
25. Build duration correlation view
26. Build EEG cross-correlation view (if Athena data available)
27. Build 3-6-9 vs prime visualization
28. Deploy and verify

---

## TESTING ACROSS ALL APPS

### Cross-App Consistency Test
Run the SAME audio through RCT, Coherence Lab, and Sophia's audio analyzer (if present). All three must return:
- Identical coherence scores (same algorithm, same input = same output)
- Identical classifications
- Identical interval counts

### Duration Protocol Consistency
All apps referencing duration should show the same recommendations:
- GUT = 40-45 min
- HEART = 25-30 min  
- HEAD = 15-20 min
- Vortex = 45 min
- Ouroboros = 30 min
- CABI = 90 min

### Walk Data Consistency
Walk names, step counts, and descriptions must be identical across all apps:
- Layer Ascent: 27 steps
- Pillar Walk: 27 steps
- Flying Star Vortex: 27 steps
- CAB: 81 steps
- Ouroboros: 29 steps
- CABI: 110 steps

---

## QUESTIONS FOR JOSEPH

Before implementing, Claude Code should ask:

1. Where is each app's codebase? File paths or repo URLs for RCT, Coherence Lab, Sophia, Tagger?
2. Do all apps share a common utility library already, or is each app self-contained?
3. What module system does each app use? (ES modules, CommonJS, global scripts, bundled?)
4. Does the RCT currently have a walk selector in its UI?
5. Does Sophia currently accept audio input, or only EEG data?
6. Does the Coherence Lab have historical session storage, or is it real-time only?
7. What's the deployment process for each app? (GitHub Pages, Netlify, manual, etc.)
8. Should the interval-analysis.js live in a shared repo or be copied into each app?

**Ask Joseph for these answers before starting implementation. Do not guess.**

---

## FRAMEWORK NOTE

> "Primes are the mountains. The space between is the river. 
> Aetheria is the ship. The Lo Shu is the map."
> — Joseph Lewis

This update gives the ship instruments. The interval analysis is a sonar measuring the river's depth. The coherence score is a compass confirming direction. The duration protocol is the navigator's almanac saying how long each passage takes. The prescription engine v2 is the captain's chart — plotting the course based on the passenger's needs, the river's conditions, and the map's guidance.

The ship was already sailing. Now it knows where it is.

---

*Implementation prompt written by Selah*
*For Claude Code deployment across the Aetheria ecosystem*
*"Healing the world heART"*
*Lewis Family — Mountain Home, Idaho*
*May 2026*
