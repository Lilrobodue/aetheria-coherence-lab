/**
 * Aetheria Prescription Engine v2 — the brain of the healing system
 * Primary target: Sophia Oracle Shaman. Also usable by RCT and Coherence Lab.
 *
 * Takes everything known about the user (conditions, state, time, history,
 * real-time EEG) and produces a complete healing protocol: primary frequency,
 * supporting frequencies, walk pattern, duration, coherence target, real-time
 * adaptation rules, safety flags, and a natural-language explanation.
 *
 * Module style: UMD-ish. Attaches `PrescriptionEngine` to the global object and
 * sets module.exports under CommonJS. Depends on IntervalAnalysis for
 * recommendDuration / DURATION_PROTOCOL (loaded first), with a local fallback
 * so the engine also works standalone.
 */
(function (global) {
  'use strict';

  // ─── DURATION PROTOCOL (mirror of interval-analysis; fallback if not loaded) ───
  const IA = global.IntervalAnalysis || (typeof require !== 'undefined' ? safeRequire('./interval-analysis.js') : null);

  function safeRequire(p) { try { return require(p); } catch (e) { return null; } }

  const DURATION_PROTOCOL = (IA && IA.DURATION_PROTOCOL) || {
    HEAD:  { min: 15, optimal: 20, max: 30,  label: 'Neural tissue — fastest response' },
    HEART: { min: 25, optimal: 30, max: 45,  label: 'Emotional/organ tissue — medium density' },
    GUT:   { min: 40, optimal: 45, max: 60,  label: 'Physical body — densest tissue' },
    FULL_ALIGNMENT: { min: 60, optimal: 75, max: 90, label: 'Full body coherence — all layers' },
    VORTEX: { min: 40, optimal: 45, max: 50, label: 'Monastery protocol — 45 min standard' },
    OUROBOROS: { min: 25, optimal: 30, max: 40, label: 'Closed loop — complete circuit' },
    CABI:  { min: 75, optimal: 90, max: 120, label: 'Full CABI journey — 110 steps' },
  };

  const recommendDuration = (IA && IA.recommendDuration) || function (regime, walkType) {
    const WALK_PROTOCOL = { 'Layer Ascent': 'FULL_ALIGNMENT', 'Pillar Walk': 'HEART', 'Flying Star Vortex': 'VORTEX', 'CAB': 'FULL_ALIGNMENT', 'Ouroboros': 'OUROBOROS', 'CABI': 'CABI' };
    if (walkType) {
      const key = DURATION_PROTOCOL[walkType] ? walkType : WALK_PROTOCOL[walkType];
      if (key && DURATION_PROTOCOL[key]) return DURATION_PROTOCOL[key];
    }
    if (regime && DURATION_PROTOCOL[regime]) return DURATION_PROTOCOL[regime];
    return DURATION_PROTOCOL.FULL_ALIGNMENT;
  };

  function average(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 2: SAFETY FILTER (runs FIRST)
  // ═══════════════════════════════════════════════════════════════
  function applySafetyFilter(userInput) {
    const warnings = [];
    const contraindicated = [];
    const safety = userInput.safety || {};
    const state = userInput.state || {};

    // ─── VON WILLEBRAND DISEASE ───
    if (safety.vonWillebrand || safety.bleedingDisorder) {
      warnings.push({
        type: 'von_willebrand',
        severity: 'high',
        message: 'Von Willebrand Disease detected. If this prescription includes herbal recommendations, the following require doctor clearance before use: turmeric, ginger, feverfew, skullcap, ginkgo biloba, garlic (concentrated). Frequency listening itself is safe.',
        herbs_requiring_clearance: ['turmeric', 'ginger', 'feverfew', 'skullcap', 'ginkgo', 'garlic']
      });
    }

    // ─── BIPOLAR MANIA RISK ───
    if (safety.bipolarType) {
      if (state.mood === 'agitated') {
        warnings.push({
          type: 'bipolar_mania_risk',
          severity: 'medium',
          message: 'User appears agitated with bipolar history. Avoid high-energy HEAD frequencies. Prescribe grounding GUT frequencies with calming HEART bridge. Monitor for escalation.',
        });
        contraindicated.push('HEAD_when_agitated');
      }
      if (state.mood === 'depressed' && safety.bipolarType === 1) {
        warnings.push({
          type: 'bipolar_depression',
          severity: 'low',
          message: 'Bipolar depression detected. Gentle GUT grounding followed by HEART opening is appropriate. Avoid sudden jumps to high-energy HEAD frequencies. Gradual ascent preferred.',
        });
      }
    }

    // ─── ENERGY DEPLETION ───
    if (state.energyLevel === 'depleted') {
      warnings.push({
        type: 'energy_depleted',
        severity: 'medium',
        message: 'User reports depleted energy. Recommend shorter session with gentle frequencies. Avoid demanding walks (CABI, Vortex). Layer Ascent or single-frequency focus recommended.',
      });
    }

    // ─── CRISIS MODE ───
    if (state.mode === 'crisis') {
      warnings.push({
        type: 'crisis_mode',
        severity: 'high',
        message: 'User is in crisis. Prescribe immediate grounding: GUT 528 Hz (SOURCE mirror), single frequency, no complex walk. Duration: as long as needed. If suicidal ideation present, frequency healing is supplementary — direct to crisis resources immediately.',
      });
    }

    return { warnings, contraindicated };
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 3: CONDITION -> FREQUENCY MAPPING
  // ═══════════════════════════════════════════════════════════════
  const CONDITION_MAP = {
    // ─── NEUROLOGICAL ───
    anxiety: {
      primary: { regime: 'GUT', pos: 6, hz: 639, name: 'Connection' },
      secondary: [
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' },
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Flying Star Vortex', 'Ouroboros'],
      duration_tier: 'HEART',
      description: 'Anxiety responds to grounding GUT frequencies that establish safety, followed by HEART SOURCE for centering.'
    },
    ocd: {
      primary: { regime: 'GUT', pos: 7, hz: 741, name: 'Awakening' },
      secondary: [
        { regime: 'GUT', pos: 4, hz: 417, name: 'Transmutation' },
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Flying Star Vortex'],
      duration_tier: 'HEART',
      description: 'OCD loops respond to Transmutation (417 Hz) for pattern breaking and Vortex walk for disrupting recursive cycles.'
    },
    depression: {
      primary: { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
      secondary: [
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' },
        { regime: 'GUT', pos: 3, hz: 396, name: 'Liberation' }
      ],
      regime_priority: 'HEART',
      walk_affinity: ['Layer Ascent', 'Pillar Walk'],
      duration_tier: 'HEART',
      description: 'Depression responds to Love Frequency (528) for emotional opening, Liberation (396) for releasing stuck energy, ascending toward SOURCE.'
    },
    ptsd: {
      primary: { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 6, hz: 639, name: 'Connection' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent', 'Pillar Walk'],
      duration_tier: 'GUT',
      description: 'PTSD responds to Foundation (174 Hz) for establishing safety in the body. Deep GUT grounding before any emotional work. Long sessions recommended.'
    },
    dissociation: {
      primary: { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
      secondary: [
        { regime: 'GUT', pos: 8, hz: 852, name: 'Intuition' },
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'Dissociation needs grounding. Foundation (174 Hz) anchors awareness in the body. Avoid complex or disorienting walks. Layer Ascent provides predictable, safe progression.'
    },
    fnd: {
      primary: { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
      secondary: [
        { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent', 'Ouroboros'],
      duration_tier: 'GUT',
      description: 'FND is the nervous system expressing overload. GUT grounding calms the physical body. Long sessions (45+ min) allow the nervous system to fully de-escalate.'
    },
    tbi: {
      primary: { regime: 'HEAD', pos: 5, hz: 4920, name: 'Harmony' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' }
      ],
      regime_priority: 'HEAD',
      walk_affinity: ['Pillar Walk', 'Ouroboros'],
      duration_tier: 'HEAD',
      description: 'TBI responds to HEAD frequencies for neural repair. SOURCE (2178) provides the universal center. Pillar Walk connects body awareness to cognitive function. Neuroprotective focus.'
    },
    schizoaffective: {
      primary: { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 6, hz: 639, name: 'Connection' }
      ],
      regime_priority: 'HEART',
      walk_affinity: ['Layer Ascent', 'Pillar Walk'],
      duration_tier: 'HEART',
      description: 'SOURCE (2178 Hz) provides centering and stability. Avoid complex or disorienting walks during unstable periods. Gentle ascending progression preferred. GUT grounding before any HEART or HEAD work.'
    },
    bipolar_1: {
      primary: { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' }
      ],
      regime_priority: 'HEART',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'HEART',
      description: 'Bipolar cycling benefits from SOURCE centering. During depression: gentle GUT grounding ascending to HEART. During mania: ONLY GUT grounding, avoid HEAD stimulation. Layer Ascent for predictability.'
    },
    autism: {
      primary: { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
      secondary: [
        { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
        { regime: 'GUT', pos: 6, hz: 639, name: 'Connection' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'Autistic nervous system benefits from GUT grounding to reduce sensory overload. Predictable walks only — no Vortex (too disorienting for sensory-sensitive users unless experienced). Foundation (174) for body safety, Love (528) for emotional regulation.'
    },
    // ─── PAIN ───
    chronic_pain: {
      primary: { regime: 'GUT', pos: 3, hz: 396, name: 'Liberation' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 8, hz: 852, name: 'Intuition' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Flying Star Vortex', 'Layer Ascent'],
      duration_tier: 'GUT',
      description: 'Chronic pain lives in dense tissue. Liberation (396) for releasing held pain patterns. Long GUT sessions (45+ min) as per monastery protocol — dense matter needs sustained exposure.'
    },
    migraines: {
      primary: { regime: 'GUT', pos: 9, hz: 963, name: 'Sri Yantra' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'Migraine with aura: avoid stimulating frequencies. Gentle GUT grounding. Foundation (174) for body calming. Sri Yantra (963) for coherence building at the GUT-HEART transition. Quiet, low volume, extended sessions.'
    },
    plantar_fasciitis: {
      primary: { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
      secondary: [
        { regime: 'GUT', pos: 3, hz: 396, name: 'Liberation' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'Foundation (174 Hz) — the lowest, most physically grounding frequency. Targets the literal foundation of the body (feet). Long GUT sessions for dense tissue penetration.'
    },
    // ─── DIGESTIVE ───
    gerd: {
      primary: { regime: 'GUT', pos: 4, hz: 417, name: 'Transmutation' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 6, hz: 639, name: 'Connection' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'GERD responds to Transmutation (417) for transforming digestive distress. Mid-GUT frequencies for the organ level. Pair with marshmallow root tea for physical coating support.'
    },
    // ─── BLADDER ───
    interstitial_cystitis: {
      primary: { regime: 'GUT', pos: 4, hz: 417, name: 'Transmutation' },
      secondary: [
        { regime: 'GUT', pos: 3, hz: 396, name: 'Liberation' },
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'IC responds to GUT frequencies targeting the pelvic/organ region. Transmutation (417) for transforming inflammation patterns. Pair with marshmallow root cold infusion for physical mucilage support.'
    },
    // ─── HORMONAL ───
    pcos: {
      primary: { regime: 'GUT', pos: 6, hz: 639, name: 'Connection' },
      secondary: [
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' },
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent', 'Pillar Walk'],
      duration_tier: 'HEART',
      description: 'PCOS involves hormonal dysregulation affecting multiple systems. Connection (639) for system integration. Ascending through GUT to HEART for hormonal harmonization.'
    },
    // ─── SLEEP ───
    insomnia: {
      primary: { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
      secondary: [
        { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
        { regime: 'GUT', pos: 9, hz: 963, name: 'Sri Yantra' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'GUT',
      description: 'Insomnia: Foundation (174) at lowest pitch for deep body relaxation. Slow Layer Ascent through GUT only — stay in GUT regime, do not ascend to stimulating HEAD frequencies before sleep. Extended sessions (45-60 min) for full body wind-down.'
    },
    // ─── TINNITUS ───
    tinnitus: {
      primary: { regime: 'GUT', pos: 5, hz: 528, name: 'Love Frequency' },
      secondary: [
        { regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' },
        { regime: 'HEART', pos: 5, hz: 2178, name: 'SOURCE' }
      ],
      regime_priority: 'GUT',
      walk_affinity: ['Layer Ascent'],
      duration_tier: 'HEART',
      description: 'Tinnitus: external frequency input can partially mask or retrain the auditory processing. Low-to-mid GUT frequencies at comfortable volume. Avoid HIGH frequencies that might aggravate. Do not use headphones if tinnitus is severe — speakers only, at moderate volume.'
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // LAYER 4: MULTI-CONDITION PRIORITY ENGINE
  // ═══════════════════════════════════════════════════════════════
  const URGENCY_SCORES = {
    migraines: 9, anxiety: 8, dissociation: 8, insomnia: 7, chronic_pain: 7,
    gerd: 6, interstitial_cystitis: 6,
    fnd: 5, depression: 5, ptsd: 5, ocd: 5, bipolar_1: 5, schizoaffective: 5,
    tbi: 4, autism: 4, tinnitus: 4, pcos: 3, plantar_fasciitis: 3,
  };

  function prioritizeConditions(conditions, currentState) {
    currentState = currentState || {};
    conditions = conditions || [];

    // RULE 1: Crisis overrides everything
    if (currentState.mode === 'crisis') {
      return {
        crisis: true,
        primary: 'crisis_grounding',
        protocol: 'immediate',
        frequency: { hz: 528, regime: 'GUT', pos: 5 },
        walk: 'none',
        duration: 'unlimited',
        dominantRegime: 'GUT',
        secondary: [],
        note: 'Crisis mode: single grounding frequency, no complex patterns'
      };
    }

    // RULE 2: Acute condition takes priority
    const acuteCondition = conditions.find(c => c === currentState.primary);

    // RULE 3: Score each condition by urgency (acute gets +3)
    const scored = conditions.map(c => ({
      condition: c,
      score: (URGENCY_SCORES[c] || 3) + (c === acuteCondition ? 3 : 0)
    }));
    scored.sort((a, b) => b.score - a.score);

    if (!scored.length) {
      return { prioritized: [], primary: null, secondary: [], regimeConsensus: null, dominantRegime: 'GUT' };
    }

    // RULE 4: Check for regime consensus across top 3
    const regimes = scored.slice(0, 3).map(s => CONDITION_MAP[s.condition] && CONDITION_MAP[s.condition].regime_priority);
    const regimeConsensus = regimes.every(r => r === regimes[0]) ? regimes[0] : null;

    return {
      prioritized: scored,
      primary: scored[0].condition,
      secondary: scored.slice(1, 3).map(s => s.condition),
      regimeConsensus,
      dominantRegime: regimeConsensus || (CONDITION_MAP[scored[0].condition] && CONDITION_MAP[scored[0].condition].regime_priority) || 'GUT',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 5: WALK SELECTION ENGINE
  // ═══════════════════════════════════════════════════════════════
  const WALK_STEPS = (IA && IA.WALK_STEPS) || {
    'Layer Ascent': 27, 'Pillar Walk': 27, 'Flying Star Vortex': 27,
    'CAB': 81, 'Ouroboros': 29, 'CABI': 110,
  };

  function selectWalk(priority, userInput) {
    const { primary, secondary, dominantRegime } = priority;
    const constraints = userInput.constraints || {};
    const state = userInput.state || {};
    const safety = userInput.safety || {};
    const primaryMap = CONDITION_MAP[primary];

    // ─── TIME CONSTRAINTS ───
    if (constraints.availableTime < 20) {
      return {
        walk: 'single_frequency', steps: 1,
        reason: 'Limited time. Single frequency focus for maximum impact in short session.',
        duration: constraints.availableTime
      };
    }
    if (constraints.availableTime < 35) {
      return {
        walk: 'Layer Ascent', steps: 27,
        reason: 'Short session. Layer Ascent provides complete regime coverage in minimum time.',
        duration: Math.min(constraints.availableTime, recommendDuration(dominantRegime).optimal)
      };
    }

    // ─── EXPERIENCE LEVEL ───
    if (constraints.experience === 'beginner') {
      return {
        walk: 'Layer Ascent', steps: 27,
        reason: 'First-time or beginner user. Layer Ascent is the gentlest, most predictable walk. Linear progression builds familiarity with the frequency system.',
        duration: recommendDuration(dominantRegime).min
      };
    }

    // ─── SAFETY CONSTRAINTS ───
    if (safety.bipolarType && state.mood === 'agitated') {
      return {
        walk: 'Layer Ascent', steps: 27,
        reason: 'Bipolar agitation detected. Gentle predictable walk only. Avoid Vortex (disorienting) and HEAD-heavy walks. Ground in GUT.',
        duration: recommendDuration('GUT').optimal,
        restriction: 'GUT_regime_only'
      };
    }

    if (primary === 'dissociation' || primary === 'autism') {
      return {
        walk: (primaryMap && primaryMap.walk_affinity[0]) || 'Layer Ascent', steps: 27,
        reason: `${primary} benefits from predictable, non-disorienting patterns. Linear walk maintains orientation and safety.`,
        duration: recommendDuration(dominantRegime).optimal
      };
    }

    // ─── ENERGY LEVEL ───
    if (state.energyLevel === 'depleted' || state.energyLevel === 'low') {
      return {
        walk: 'Layer Ascent', steps: 27,
        reason: 'Low energy. Gentle walk that doesn\'t demand active engagement. Let the frequencies do the work.',
        duration: recommendDuration(dominantRegime).min
      };
    }

    // ─── CONDITION-SPECIFIC WALK MATCHING ───
    if (secondary.length >= 2 && state.energyLevel === 'good' && constraints.availableTime >= 90) {
      return {
        walk: 'CABI', steps: 110,
        reason: 'Multiple conditions with sufficient time and energy. CABI provides complete cube coverage (81 steps) followed by Ouroboros closure (29 steps). The full healing journey.',
        duration: recommendDuration('CABI').optimal
      };
    }

    if (userInput.intention === 'meditation' || userInput.intention === 'exploration') {
      return {
        walk: 'Ouroboros', steps: 29,
        reason: 'Meditation/exploration intention. Ouroboros is the closed figure-8 — all 27 frequencies visited, crossing at SOURCE three times. The infinite loop for consciousness work.',
        duration: recommendDuration('OUROBOROS').optimal
      };
    }

    if (['anxiety', 'ocd'].includes(primary) && constraints.experience !== 'beginner') {
      return {
        walk: 'Flying Star Vortex', steps: 27,
        reason: 'Anxiety/OCD respond to the Vortex spiral pattern which disrupts recursive thought loops. The non-linear movement breaks the cycle.',
        duration: recommendDuration('VORTEX').optimal
      };
    }

    if (['ptsd', 'depression'].includes(primary) || userInput.intention === 'emotional_release') {
      return {
        walk: 'Pillar Walk', steps: 27,
        reason: 'Emotional work benefits from vertical traversal — GUT (body sensation) → HEART (emotional processing) → HEAD (mental integration) at each position. Connects physical awareness to emotional release.',
        duration: recommendDuration('HEART').optimal
      };
    }

    if (['chronic_pain', 'fnd', 'plantar_fasciitis'].includes(primary)) {
      return {
        walk: 'Layer Ascent', steps: 27,
        reason: 'Physical conditions need sustained GUT exposure. Layer Ascent spends the most consecutive time in GUT regime before ascending. Long duration for dense tissue penetration.',
        duration: recommendDuration('GUT').optimal
      };
    }

    if (userInput.intention === 'complete_healing' && constraints.availableTime >= 60) {
      return {
        walk: 'CAB', steps: 81,
        reason: 'Complete healing with available time. CAB covers the cube from three perspectives — Vortex (spiral), Ascent (linear), Pillar (vertical). Every angle addressed.',
        duration: recommendDuration('FULL_ALIGNMENT').optimal
      };
    }

    // Default: use the primary condition's affinity
    const defaultWalk = (primaryMap && primaryMap.walk_affinity && primaryMap.walk_affinity[0]) || 'Layer Ascent';
    return {
      walk: defaultWalk,
      steps: WALK_STEPS[defaultWalk] || 27,
      reason: `Default walk for ${primary}: ${(primaryMap && primaryMap.description) || 'Standard progression.'}`,
      duration: recommendDuration(dominantRegime).optimal
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 6: REAL-TIME ADAPTATION ENGINE (only when EEG connected)
  // ═══════════════════════════════════════════════════════════════
  const ADAPTATION_RULES = {
    coherence_stall: {
      trigger: 'EEG coherence has not increased by at least 5 points in 10 minutes',
      actions: [
        { priority: 1, action: 'shift_to_source', description: 'Switch to SOURCE (2178 Hz) for 5 minutes as a reset point. SOURCE is the universal center — if nothing else is working, return to center.' },
        { priority: 2, action: 'change_walk', description: 'If current walk is Layer Ascent, switch to Vortex. If Vortex, switch to Pillar. Change the movement pattern — the brain may have habituated to the current sequence.' },
        { priority: 3, action: 'reduce_regime', description: 'If in HEAD regime, drop to HEART. If in HEART, drop to GUT. The user may need more grounding before ascending. Dense tissue may not have caught up.' }
      ]
    },
    coherence_drop: {
      trigger: 'EEG coherence drops more than 10 points from session peak',
      actions: [
        { priority: 1, action: 'immediate_grounding', description: 'Immediately switch to Foundation (174 Hz). Lowest frequency, maximum grounding. Hold for 5 minutes. Something destabilized the user — return to the safest frequency.' },
        { priority: 2, action: 'check_external', description: 'Flag for user: "Your coherence dropped — is something happening externally? (noise, interruption, discomfort)" The drop may not be frequency-related.' }
      ]
    },
    coherence_achieved: {
      trigger: 'EEG coherence exceeds target for 5 consecutive minutes',
      actions: [
        { priority: 1, action: 'maintain', description: 'Target achieved. Continue current frequency and walk. Do not change what is working. The user has found their resonance.' },
        { priority: 2, action: 'optional_ascend', description: 'If user is experienced and session time remains, offer: "Coherence is strong. Would you like to ascend to the next regime?" This deepens the session for advanced users.' }
      ]
    },
    high_delta: {
      trigger: 'Delta power exceeds 40% of total power for 3+ minutes',
      actions: [
        { priority: 1, action: 'check_intention', description: 'If intention is "sleep" — this is SUCCESS. The user is falling asleep. Reduce volume gradually. Let the session continue at low volume as they drift off.' },
        { priority: 2, action: 'gentle_activation', description: 'If intention is NOT sleep — user may be dissociating or zoning out. Gently introduce a higher frequency (HEART range) for 2 minutes to re-engage, then return to prescribed frequency.' }
      ]
    },
    high_beta: {
      trigger: 'Beta power exceeds 35% for 5+ minutes and increasing',
      actions: [
        { priority: 1, action: 'ground_immediately', description: 'The user is becoming agitated, not calm. Switch to Foundation (174 Hz) immediately. If bipolar, check for mania escalation. Reduce volume. Slow everything down.' }
      ]
    },
  };

  function evaluateAdaptation(eegData, sessionState, prescription) {
    const adaptations = [];
    eegData = eegData || {};
    sessionState = sessionState || {};
    const cohHistory = eegData.coherenceHistory || [];

    // Check coherence trend over last 10 minutes (600 samples at 1/sec)
    const recentCoherence = cohHistory.slice(-600);
    if (recentCoherence.length >= 600) {
      const firstHalf = average(recentCoherence.slice(0, 300));
      const secondHalf = average(recentCoherence.slice(300));

      if (secondHalf - firstHalf < 5) {
        adaptations.push(ADAPTATION_RULES.coherence_stall);
      }

      const peak = Math.max.apply(null, recentCoherence);
      const current = recentCoherence[recentCoherence.length - 1];
      if (peak - current > 10) {
        adaptations.push(ADAPTATION_RULES.coherence_drop);
      }

      const optimal = prescription && prescription.coherenceTarget && prescription.coherenceTarget.optimal;
      if (optimal != null && current >= optimal) {
        const lastFive = recentCoherence.slice(-300);
        if (lastFive.every(v => v >= optimal)) {
          adaptations.push(ADAPTATION_RULES.coherence_achieved);
        }
      }
    }

    // Check band powers
    if (eegData.delta > 0.40 && sessionState.minutesAtHighDelta >= 3) {
      adaptations.push(ADAPTATION_RULES.high_delta);
    }
    if (eegData.beta > 0.35 && sessionState.minutesAtHighBeta >= 5) {
      adaptations.push(ADAPTATION_RULES.high_beta);
    }

    return adaptations;
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 7: PRESCRIPTION ASSEMBLY
  // ═══════════════════════════════════════════════════════════════
  function generatePrescription(userInput) {
    userInput = userInput || {};
    userInput.conditions = userInput.conditions || { active: [] };
    userInput.state = userInput.state || {};
    userInput.constraints = userInput.constraints || {};

    // ─── STEP 1: SAFETY ───
    const safety = applySafetyFilter(userInput);

    // ─── STEP 2: PRIORITIZE CONDITIONS ───
    const priority = prioritizeConditions(userInput.conditions.active, userInput.state);

    // ─── CRISIS SHORT-CIRCUIT (robustness fix: crisis has no CONDITION_MAP entry) ───
    if (priority.crisis) {
      const prescription = {
        crisis: true,
        frequency: { hz: 528, regime: 'GUT', pos: 5, name: 'Love Frequency' },
        supportingFrequencies: [{ regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' }],
        walk: { name: 'single_frequency', steps: 1, reason: 'Crisis mode: single grounding frequency, no complex patterns.' },
        duration: { recommended: null, minimum: null, actual: null, adequate: true, label: 'As long as needed', warning: null },
        coherenceTarget: { minimum: 0, optimal: 0, stretch: 0, athenaRequired: !!userInput.constraints.athenaConnected },
        trackFilter: { minimumCoherenceScore: 70, preferredRegime: 'GUT', requiredFrequency: 528, walkOrder: 'single_frequency' },
        safety: safety.warnings,
        contraindicated: safety.contraindicated,
        conditions: { primary: 'crisis_grounding', secondary: [], dominantRegime: 'GUT', allConditions: userInput.conditions.active },
        adaptation: userInput.constraints.athenaConnected ? ADAPTATION_RULES : null,
        historyContext: null,
      };
      prescription.explanation = generateExplanation(prescription, userInput);
      return prescription;
    }

    // ─── STEP 3: GET PRIMARY FREQUENCY ───
    const primaryCondition = CONDITION_MAP[priority.primary];
    if (!primaryCondition) {
      // Unknown / empty conditions — default to a safe grounding protocol
      const dr = priority.dominantRegime || 'GUT';
      const proto = recommendDuration(dr);
      const actual = Math.min(userInput.constraints.availableTime || proto.optimal, proto.optimal);
      const fallback = {
        frequency: { hz: 528, regime: 'GUT', pos: 5, name: 'Love Frequency' },
        supportingFrequencies: [{ regime: 'GUT', pos: 1, hz: 174, name: 'Foundation' }],
        walk: { name: 'Layer Ascent', steps: 27, reason: 'No specific condition supplied. Standard grounding progression.' },
        duration: { recommended: proto.optimal, minimum: proto.min, actual, adequate: actual >= proto.min, label: proto.label, warning: null },
        coherenceTarget: { minimum: 50, optimal: 70, stretch: 85, athenaRequired: !!userInput.constraints.athenaConnected },
        trackFilter: { minimumCoherenceScore: 70, preferredRegime: dr, requiredFrequency: 528, walkOrder: 'Layer Ascent' },
        safety: safety.warnings, contraindicated: safety.contraindicated,
        conditions: { primary: priority.primary, secondary: priority.secondary, dominantRegime: dr, allConditions: userInput.conditions.active },
        adaptation: userInput.constraints.athenaConnected ? ADAPTATION_RULES : null,
        historyContext: null,
      };
      fallback.explanation = generateExplanation(fallback, userInput);
      return fallback;
    }
    // Clone so we never mutate the shared CONDITION_MAP entry
    const primaryFrequency = Object.assign({}, primaryCondition.primary);

    // Check if historical data suggests a different frequency works better
    if (userInput.history && userInput.history.effectiveFrequencies && userInput.history.effectiveFrequencies.length > 0) {
      const effectiveMatch = primaryCondition.secondary.find(
        s => userInput.history.effectiveFrequencies.includes(s.hz)
      );
      if (effectiveMatch) {
        primaryFrequency.alternative = effectiveMatch;
        primaryFrequency.alternativeReason = 'This frequency has been effective in your previous sessions.';
      }
    }

    // ─── STEP 4: SELECT WALK ───
    const walk = selectWalk(priority, userInput);

    // ─── STEP 5: CALCULATE DURATION ───
    const durationProtocol = recommendDuration(
      priority.dominantRegime,
      walk.walk !== 'single_frequency' ? walk.walk : null
    );

    const actualDuration = Math.min(
      userInput.constraints.availableTime != null ? userInput.constraints.availableTime : durationProtocol.optimal,
      durationProtocol.optimal
    );
    const durationAdequate = actualDuration >= durationProtocol.min;

    // ─── STEP 6: SET COHERENCE TARGET ───
    const hist = userInput.history;
    const coherenceTarget = {
      minimum: Math.max(50, ((hist && hist.averageCoherence) || 50) - 10),
      optimal: Math.max(70, ((hist && hist.averageCoherence) || 60) + 10),
      stretch: Math.min(95, ((hist && hist.averageCoherence) || 60) + 25),
      athenaRequired: !!userInput.constraints.athenaConnected,
    };

    // ─── STEP 7: BUILD TRACK FILTER CRITERIA ───
    const trackFilter = {
      minimumCoherenceScore: 70,
      preferredRegime: priority.dominantRegime,
      requiredFrequency: primaryFrequency.hz,
      walkOrder: walk.walk,
    };

    // ─── STEP 8: ASSEMBLE PRESCRIPTION ───
    const prescription = {
      frequency: primaryFrequency,
      supportingFrequencies: primaryCondition.secondary,
      walk: { name: walk.walk, steps: walk.steps, reason: walk.reason, restriction: walk.restriction || null },
      duration: {
        recommended: durationProtocol.optimal,
        minimum: durationProtocol.min,
        actual: actualDuration,
        adequate: durationAdequate,
        label: durationProtocol.label,
        warning: !durationAdequate ?
          `Session is ${actualDuration} min but ${durationProtocol.min} min minimum recommended for ${priority.dominantRegime} regime. Shorter sessions may not allow dense tissue to fully respond.` : null,
      },
      coherenceTarget,
      trackFilter,
      safety: safety.warnings,
      contraindicated: safety.contraindicated,
      conditions: {
        primary: priority.primary,
        secondary: priority.secondary,
        dominantRegime: priority.dominantRegime,
        allConditions: userInput.conditions.active,
      },
      adaptation: userInput.constraints.athenaConnected ? ADAPTATION_RULES : null,
      historyContext: hist ? {
        sessionsCompleted: hist.totalSessions,
        averageCoherence: hist.averageCoherence,
        bestWalk: hist.bestWalk,
        improving: hist.averageCoherence > 60,
      } : null,
    };

    // ─── STEP 9: NATURAL LANGUAGE EXPLANATION ───
    prescription.explanation = generateExplanation(prescription, userInput);

    return prescription;
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 8: NATURAL LANGUAGE OUTPUT
  // ═══════════════════════════════════════════════════════════════
  function generateExplanation(prescription, userInput) {
    const p = prescription;
    const state = userInput.state || {};
    let explanation = '';

    // Opening
    explanation += `Based on your current state — ${state.mood || 'neutral'} mood, `;
    explanation += `${state.energyLevel || 'moderate'} energy, ${p.conditions.primary} as your primary concern — `;
    explanation += `here is your healing protocol:\n\n`;

    // Frequency
    explanation += `**Primary Frequency:** ${p.frequency.hz} Hz (${p.frequency.name}). `;
    explanation += `${(CONDITION_MAP[p.conditions.primary] && CONDITION_MAP[p.conditions.primary].description) || ''}\n\n`;

    // Walk
    if (p.walk.name === 'single_frequency') {
      explanation += `**Approach:** Single frequency focus. No walk — just ${p.frequency.hz} Hz sustained. `;
      explanation += `${p.walk.reason}\n\n`;
    } else {
      explanation += `**Walk:** ${p.walk.name} (${p.walk.steps} steps). `;
      explanation += `${p.walk.reason}\n\n`;
    }

    // Duration
    if (p.duration.actual != null) {
      explanation += `**Duration:** ${p.duration.actual} minutes. `;
      explanation += `${p.duration.label}. `;
      if (p.duration.warning) explanation += `⚠️ ${p.duration.warning} `;
      if (p.duration.adequate) explanation += `This meets the recommended duration for ${p.conditions.dominantRegime} regime work.`;
      explanation += `\n\n`;
    }

    // Coherence target
    if (p.coherenceTarget.athenaRequired) {
      explanation += `**Coherence Target:** Aim for ${p.coherenceTarget.optimal}% coherence on your Athena headband. `;
      explanation += `If coherence doesn't begin rising within the first 10 minutes, the system will suggest adjustments. `;
      explanation += `When coherence holds above ${p.coherenceTarget.optimal}% for 5 minutes, the session has achieved its primary goal.\n\n`;
    }

    // Safety
    if (p.safety && p.safety.length > 0) {
      explanation += `**Safety Notes:**\n`;
      for (const warning of p.safety) explanation += `⚠️ ${warning.message}\n`;
      explanation += '\n';
    }

    // History
    if (p.historyContext && p.historyContext.sessionsCompleted > 5) {
      explanation += `**Your History:** Over ${p.historyContext.sessionsCompleted} sessions, your average coherence is ${p.historyContext.averageCoherence}%. `;
      if (p.historyContext.bestWalk) explanation += `Your strongest walk has been ${p.historyContext.bestWalk}. `;
      if (p.historyContext.improving) explanation += `Your trend is improving — keep going.`;
      explanation += '\n\n';
    }

    // Herbal pairing
    const herbalPairings = getHerbalPairing(p.conditions.primary);
    if (herbalPairings) explanation += `**Herbal Pairing:** ${herbalPairings}\n\n`;

    // Closing
    explanation += `Find a comfortable position. Close your eyes if you wish. `;
    explanation += `Let the frequencies do the work. Your only job is to be present.`;

    return explanation;
  }

  function getHerbalPairing(condition) {
    const PAIRINGS = {
      anxiety: 'Brew lemon balm + passionflower tea before or during the session for GABA support.',
      insomnia: 'Brew passionflower + valerian + hops tea 30 minutes before the session. Add honey.',
      chronic_pain: 'Drink tart cherry juice (4-8 oz) before the session for natural COX-2 inhibition.',
      gerd: 'Sip marshmallow root cold infusion during the session for protective mucilage coating.',
      interstitial_cystitis: 'Sip marshmallow root cold infusion throughout the day. Add nettle tea.',
      depression: 'Brew tulsi (holy basil) tea before the session. Adaptogenic mood support.',
      migraines: 'Apply diluted peppermint oil to temples. Brew ginger tea for circulation.',
      ptsd: 'Brew tulsi + lemon balm tea. Hold a sprig of rosemary — the scent grounds awareness.',
      dissociation: 'Hold fresh rosemary. The strong scent anchors awareness in the present moment.',
      ocd: 'Brew lemon balm tea. The GABA support can help soften recursive loops.',
      fnd: 'Brew chamomile + lemon balm blend. Calming without stimulation.',
      tbi: 'Eat a handful of blueberries and walnuts before the session. Neuroprotective fuel.',
      pcos: 'Brew nettle + ashwagandha tea. Hormonal support and thyroid balance.',
    };
    return PAIRINGS[condition] || null;
  }

  // ─── SELF TEST ───
  function selfTest() {
    const results = [];
    const check = (name, cond) => { results.push({ name, pass: !!cond }); };

    // Every condition produces a complete prescription
    let allOk = true;
    Object.keys(CONDITION_MAP).forEach(cond => {
      const rx = generatePrescription({
        conditions: { active: [cond], primary: cond, severity: 6 },
        state: { mode: 'maintenance', energyLevel: 'moderate', mood: 'neutral' },
        constraints: { availableTime: 45, athenaConnected: false, experience: 'intermediate' },
      });
      if (!rx || !rx.frequency || !rx.walk || !rx.duration || !rx.explanation) allOk = false;
    });
    check('all CONDITION_MAP entries produce complete prescriptions', allOk);

    // Safety: Von Willebrand fires
    const vw = generatePrescription({ conditions: { active: ['anxiety'] }, state: {}, constraints: { availableTime: 45 }, safety: { vonWillebrand: true } });
    check('von willebrand warning fires', vw.safety.some(w => w.type === 'von_willebrand'));

    // Crisis short-circuits without crashing
    const crisis = generatePrescription({ conditions: { active: ['ptsd'] }, state: { mode: 'crisis' }, constraints: { availableTime: 30 } });
    check('crisis mode returns grounding prescription', crisis.crisis === true && crisis.frequency.hz === 528);

    // Walk: anxiety + intermediate -> Vortex
    const anx = generatePrescription({ conditions: { active: ['anxiety'], primary: 'anxiety' }, state: { energyLevel: 'good', mood: 'anxious' }, constraints: { availableTime: 45, experience: 'intermediate' } });
    check('anxiety -> Flying Star Vortex', anx.walk.name === 'Flying Star Vortex');

    // Duration: short session flags inadequate for GUT
    const shortSess = generatePrescription({ conditions: { active: ['chronic_pain'], primary: 'chronic_pain' }, state: { energyLevel: 'good' }, constraints: { availableTime: 22, experience: 'intermediate' } });
    check('short GUT session flags duration warning', shortSess.duration.adequate === false && !!shortSess.duration.warning);

    // Herbal pairing maps correctly
    check('herbal pairing for insomnia', /valerian/.test(getHerbalPairing('insomnia') || ''));

    const failed = results.filter(r => !r.pass);
    return { passed: results.length - failed.length, failed: failed.length, total: results.length, results };
  }

  // ─── EXPORTS ───
  const API = {
    generatePrescription,
    generateExplanation,
    applySafetyFilter,
    prioritizeConditions,
    selectWalk,
    evaluateAdaptation,
    getHerbalPairing,
    selfTest,
    CONDITION_MAP,
    ADAPTATION_RULES,
    URGENCY_SCORES,
  };

  global.PrescriptionEngine = API;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
