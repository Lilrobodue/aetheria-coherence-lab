# Aetheria Coherence Lab — Test App Build Spec

**Document 4 of 5** · Spec for Claude Code · v0.1
**Stack:** HTML5 / JavaScript (ES modules) / Web Bluetooth / Web Audio
**Target:** Browser-based, runs on desktop and ASUS ROG Phone 9 Pro
**Purpose:** Reference implementation of the Aetheria adaptive closed-loop system. Built first as a standalone test app, then its modules propagate into the rest of the Aetheria ecosystem.

---

## 1. Why This App Exists

This is not a consumer product. This is the **reference implementation** — the place where the architecture of Docs 1-3 becomes real code, gets tested against real biosignal, and is refined until every module behaves correctly. Once the lab is working, its modules become the foundation that Sophia Ultra, the Quantum Frequency Engine, Prema Amara, and every future Aetheria web app upgrade against.

Build once. Integrate many. The lab is the seed.

**Design principles:**
1. **Transparent over polished.** Every internal value visible. Every decision logged with a plain-English reason.
2. **Modular over monolithic.** Each concept from the spec is its own module with a clean interface.
3. **Reusable over app-specific.** No module knows it lives in the lab. Each one drops into any future Aetheria app unchanged.
4. **Replayable over ephemeral.** Every session is recorded as JSON and can be re-run through the policy offline for tuning.
5. **Observable over assumed.** When something doesn't work, you can see exactly which module failed and why.

---

## 2. Project Layout

```
aetheria-lab/
├── index.html                  # single-page app shell
├── main.js                     # bootstraps modules, wires them together
│
├── sensors/
│   ├── polar-h10.js            # Web Bluetooth GATT client for H10
│   ├── muse-athena.js          # Web Bluetooth client for Muse (EEG/fNIRS/PPG/IMU)
│   └── sensor-base.js          # shared base class: connect, disconnect, status
│
├── streams/
│   ├── event-bus.js            # internal pub/sub replacing LSL
│   ├── ring-buffer.js          # 60-second rolling window per stream
│   └── stream-registry.js      # central registry of active streams
│
├── features/
│   ├── heart-features.js       # RMSSD, pNN50, SDNN, LF/HF, HRV coherence
│   ├── gut-features.js         # HF power, SD1, RSA amplitude
│   ├── head-features.js        # band powers, IAF, alpha asymmetry, fNIRS
│   ├── respiration.js          # ECG-derived respiration (EDR)
│   └── feature-engine.js       # orchestrates all feature extraction at 1 Hz
│
├── coherence/
│   ├── regime-scoring.js       # GUT_score, HEART_score, HEAD_score
│   ├── cross-regime.js         # PLV, harmonic ratio detection
│   ├── tcs.js                  # Triune Coherence Score
│   └── coherence-vector.js     # the full live state object
│
├── policy/
│   ├── state-machine.js        # STARTUP → BASELINE → ASSESS → ... → COMPLETE
│   ├── arousal-anchor.js       # session-anchored arousal index + flip detection
│   ├── selection-rules.js      # frequency selection logic (§3 of Doc 3)
│   ├── evaluate-rules.js       # HOLD / ADVANCE / PIVOT cascade (§4 of Doc 3)
│   └── prescription.js         # ties policy decisions to delivery commands
│
├── delivery/
│   ├── audio-binaural.js       # Web Audio binaural beat generator
│   ├── haptic-woojer.js        # Woojer Strap 3 driver (audio sub-channel)
│   ├── heartbeat-signature.js  # the closing LUB-dub end pattern
│   └── delivery-coordinator.js # orchestrates audio + haptic in sync
│
├── recording/
│   ├── session-recorder.js     # writes session JSON
│   ├── session-replay.js       # re-runs policy on a recorded session
│   └── session-report.js       # generates the post-session summary
│
├── viz/
│   ├── live-dashboard.js       # the main observability window
│   ├── signal-panel.js         # raw ECG/EEG/fNIRS plots
│   ├── feature-panel.js        # derived feature plots
│   ├── coherence-panel.js      # per-regime + TCS gauges
│   ├── state-panel.js          # current state, current frequency, transition log
│   └── plot-base.js            # shared lightweight plot helper (Canvas-based)
│
├── math/
│   ├── fft.js                  # FFT and Welch PSD
│   ├── hilbert.js              # Hilbert transform for PLV
│   ├── filters.js              # bandpass, lowpass
│   ├── stats.js                # z-score, sigmoid, linear regression
│   └── digital-root.js         # the 3-6-9 reduction
│
├── config/
│   ├── frequencies.json        # the 27-frequency library with regime/digital_root
│   ├── policy.json             # all tunable thresholds
│   └── user-profiles/          # per-user JSON profiles
│
└── lib/                        # third-party (loaded via ESM CDN where possible)
```

**Module rules:**
- Every file in `sensors/`, `features/`, `coherence/`, `policy/`, `delivery/`, `recording/`, `math/` is **pure** — no DOM, no UI, no app-specific assumptions. They take data in and return data out.
- Only `viz/`, `index.html`, and `main.js` touch the DOM.
- All inter-module communication goes through the event bus. Modules never reach into each other directly.
- Every module exports its public functions/classes via ES module exports. No globals.

---

## 2.5 Physical Setup Assumed by the Code

The lab assumes a specific hardware topology that the delivery modules are built around. Claude Code does not need to invent or detect this — it just needs to follow the assumption.

**Sensors (data in via Bluetooth Low Energy):**
- Polar H10 chest strap → Web Bluetooth → publishes ECG and R-R streams
- Muse S Athena headband → Web Bluetooth → publishes EEG, fNIRS, PPG, IMU streams

**Delivery (audio out via single wired stereo path):**
- Host device's 3.5mm stereo output → powered passive splitter with independent per-output volume controls → both headphones AND Woojer Strap 3 simultaneously
- Headphones receive the binaural carriers and the brain reconstructs the beat
- Woojer receives the same stereo signal and delivers it as tactile sensation
- Per-device volume is set at the physical splitter knobs, not in software
- Software controls only the *signal content* — frequency, mix balance between binaural carrier and any sub-octave haptic component, master mute

**Critical implications for the code:**
1. There is **only one audio output device** from the browser's perspective. The default Web Audio destination routes to both headphones and Woojer simultaneously through the splitter.
2. The delivery modules do **not** need to enumerate audio devices or pick an output. They use the default `AudioContext.destination`.
3. The binaural left/right channels are generated in software using stereo `OscillatorNode`s with `ChannelMergerNode` or `StereoPannerNode`. This works identically for the headphones and the Woojer because the splitter is passive.
4. For frequencies above the Woojer's 800 Hz upper range, the driver mixes a sub-octave sine into the stereo signal at low amplitude. The headphones perceive it as a subtle bass undertone; the Woojer feels it as the dominant tactile signal.
5. **No Bluetooth audio.** Bluetooth is used only for the two BLE sensor data streams. The Woojer is wired, not BT-paired, in this configuration.

This topology is documented in detail in Doc 1 §1.5 with the full rationale (zero latency for the heartbeat end-signature, no codec compression of the GUT-regime sub-bass, no pairing conflicts with the BLE sensor stack).

---

## 3. The Event Bus (LSL Replacement)

LSL doesn't exist in the browser, so we replace it with a tiny internal pub/sub. Same conceptual role: every signal stream and every derived value flows through one place, every module subscribes to what it needs and publishes what it produces.

```javascript
// streams/event-bus.js
export class EventBus extends EventTarget {
  publish(streamName, payload) {
    this.dispatchEvent(new CustomEvent(streamName, {
      detail: { ...payload, timestamp: performance.now() / 1000 }
    }));
  }
  subscribe(streamName, handler) {
    const wrapped = (e) => handler(e.detail);
    this.addEventListener(streamName, wrapped);
    return () => this.removeEventListener(streamName, wrapped);
  }
}

export const bus = new EventBus();
```

**Stream names** (mirror Doc 1's LSL streams):
- `Aetheria_ECG`, `Aetheria_RR`, `Aetheria_EEG`, `Aetheria_fNIRS`, `Aetheria_PPG`, `Aetheria_IMU`
- `Aetheria_Audio`, `Aetheria_Haptic`
- `Aetheria_Features`, `Aetheria_Coherence`, `Aetheria_State`, `Aetheria_Prescription`

**Why this works:** `EventTarget` is built into every browser, has zero dependencies, and gives you the same publish/subscribe pattern LSL provides — minus the cross-process synchronization, which we don't need because everything runs in one tab. Timestamps come from `performance.now()` which has sub-millisecond resolution, more than enough for our 1 Hz update cycle.

**Future LSL bridge:** if you ever want to export sessions to external research tools, write one bridge module that subscribes to all streams and pipes them to a Python LSL outlet via WebSocket. The rest of the system never knows.

---

## 4. Module Interface Contracts

These are the function signatures Claude Code should implement. Each module's public surface is small and explicit.

### 4.1 Sensors

```javascript
// sensors/polar-h10.js
export class PolarH10 {
  async connect()                  // BLE pairing, returns when stream begins
  async disconnect()
  get status()                     // 'disconnected' | 'connecting' | 'streaming' | 'error'
  get contactQuality()             // 0-1 scalar
  // Publishes to bus: 'Aetheria_ECG' (130 Hz), 'Aetheria_RR' (event rate)
}

// sensors/muse-athena.js
export class MuseAthena {
  async connect()
  async disconnect()
  get status()
  get contactQuality()             // per-channel object: {TP9, AF7, AF8, TP10}
  // Publishes: 'Aetheria_EEG' (256 Hz), 'Aetheria_fNIRS' (10 Hz),
  //            'Aetheria_PPG' (64 Hz), 'Aetheria_IMU' (52 Hz)
}
```

### 4.2 Features

```javascript
// features/feature-engine.js
export class FeatureEngine {
  constructor(bus, config)
  start()                          // begins 1 Hz extraction loop
  stop()
  // Subscribes to: all sensor streams
  // Publishes to: 'Aetheria_Features' (1 Hz)
}

// features/heart-features.js
export function computeHeartFeatures(rrWindow, ecgWindow) {
  return {
    rmssd, pnn50, sdnn, meanHR,
    vlf, lf, hf, lfHfRatio, hfNorm,
    hrvCoherence, peakFreq
  };
}

// features/gut-features.js
export function computeGutFeatures(rrWindow, respWindow) {
  return { hfPower, sd1, rsaAmplitude };
}

// features/head-features.js
export function computeHeadFeatures(eegWindow, fnirsWindow, iaf) {
  return {
    delta, theta, alpha, beta, gamma,
    alphaPowerNorm, thetaAlphaRatio, frontalAlphaAsymmetry,
    hbO, hbR, hbT, hbDiff
  };
}
```

### 4.3 Coherence

```javascript
// coherence/regime-scoring.js
export function scoreGut(features, baseline)    // returns z-scored scalar
export function scoreHeart(features, baseline)
export function scoreHead(features, baseline)

// coherence/cross-regime.js
export function computePLV(envelopeA, envelopeB)              // 0-1
export function computeTriunePLV(gutEnv, heartEnv, headEnv)   // 0-1
export function detectHarmonicLock(freqs)                     // 0-1

// coherence/tcs.js
export function computeTCS(gut, heart, head, triunePLV, harmonicLock) {
  return scalar0to100;
}

// coherence/coherence-vector.js
export class CoherenceEngine {
  constructor(bus, config)
  start()
  stop()
  // Subscribes to: 'Aetheria_Features'
  // Publishes to: 'Aetheria_Coherence' at 1 Hz
}
```

### 4.4 Policy

```javascript
// policy/arousal-anchor.js
export class ArousalAnchor {
  setAnchor(baselineFeatures)              // call at end of BASELINE
  computeDrift(currentFeatures)            // returns drift from anchor
  shouldFlip(currentDirection, drift)      // returns 'ASCENDING' | 'DESCENDING' | null
}

// policy/selection-rules.js
export function selectFirstFrequency(coherenceVector, anchor, library)
export function selectNextFrequency(hint, currentFreq, coherenceVector, anchor, library, history)

// policy/evaluate-rules.js
export function evaluate(tcsHistory, coherenceVector, entryVector) {
  return 'HOLD' | 'ADVANCE' | 'PIVOT';
}

// policy/state-machine.js
export class PolicyEngine {
  constructor(bus, config, library)
  start()
  stop()
  get currentState()
  // Subscribes to: 'Aetheria_Coherence'
  // Publishes to:  'Aetheria_State', 'Aetheria_Prescription'
}
```

### 4.5 Delivery

```javascript
// delivery/audio-binaural.js
export class BinauralPlayer {
  constructor(audioContext)
  async play(targetFreqHz, carrierBaseHz)   // crossfades from current
  async stop()
  setVolume(0to1)
}

// delivery/haptic-woojer.js
export class WoojerDriver {
  constructor(audioContext)
  // Routes via the host's default 3.5mm output, which is split passively
  // to both headphones and the Woojer. The Woojer receives the same stereo
  // signal as the headphones; per-output volume is set at the physical splitter.
  // For octave-shifted haptic frequencies, this driver mixes a sub-octave
  // sine into the same stereo channels at controlled amplitude.
  async play(freqHz)
  async stop()
  setSubOctaveAmplitude(0to1)               // controls the haptic-only mix component
}

// delivery/heartbeat-signature.js
export async function playHeartbeatSignature(woojer, freqHz) {
  // 3 cycles, slowing tempo, softening amplitude
  // Returns when complete
}

// delivery/delivery-coordinator.js
export class DeliveryCoordinator {
  constructor(bus, audioPlayer, hapticDriver)
  start()
  // Subscribes to: 'Aetheria_Prescription'
  // Publishes to:  'Aetheria_Audio', 'Aetheria_Haptic'
}
```

### 4.6 Recording

```javascript
// recording/session-recorder.js
export class SessionRecorder {
  constructor(bus, sessionId, userId)
  start()
  stop()
  async export()                            // returns JSON blob, triggers download
  // Subscribes to: ALL streams, writes everything timestamped
}

// recording/session-replay.js
export class SessionReplayer {
  constructor(bus, sessionJson)
  async run(speedMultiplier = 1.0)          // replays into the same bus
  // Republishes recorded streams at original cadence
}

// recording/session-report.js
export function generateReport(sessionJson) {
  return {
    duration, baselineTcs, finalTcs, peakTcs,
    frequenciesPlayed: [...],
    pivots, holds, advances,
    deficitAtStart, deficitAtEnd,
    triunePlvAtStart, triunePlvAtEnd,
    notes
  };
}
```

---

## 5. Live Dashboard Layout

The viz window is the part you'll actually look at during sessions. Built with HTML + CSS Grid + Canvas-based plots (no heavy charting library; the plots are simple enough to hand-roll for max performance).

```
┌─────────────────────────────────────────────────────────────────┐
│  AETHERIA COHERENCE LAB                          [Connect][Start]│
├─────────────────────────────────────────────────────────────────┤
│  STATE: ENTRAIN              CASCADE: ASCENDING (anchor: -0.12) │
│  Now playing: 528 Hz · HEART · root 6 · octave 1                │
│  Time in state: 00:42        Time in session: 12:18             │
├──────────────────────┬──────────────────────┬───────────────────┤
│   RAW SIGNALS        │   FEATURES           │   COHERENCE       │
│                      │                      │                   │
│   ECG     ~~~~~~~    │   RMSSD    ████░░    │   GUT    ●●●●○    │
│   EEG_AF7 ~~~~~~~    │   HF Power ███░░░    │   HEART  ●●●●●    │
│   EEG_AF8 ~~~~~~~    │   Alpha    █████░    │   HEAD   ●●●○○    │
│   fNIRS   ~~~~~~~    │   Beta     ██░░░░    │                   │
│   PPG     ~~~~~~~    │   HRV Coh  ████░░    │   PLV_GH  0.71    │
│                      │   IAF      9.8 Hz    │   PLV_HD  0.52    │
│                      │                      │   PLV_GD  0.48    │
│                      │                      │   Triune  0.57    │
│                      │                      │                   │
│                      │                      │   ┌─────────┐     │
│                      │                      │   │   TCS   │     │
│                      │                      │   │   72    │     │
│                      │                      │   └─────────┘     │
├──────────────────────┴──────────────────────┴───────────────────┤
│  TRANSITION LOG                                                  │
│  12:14  ASSESS → PRESCRIBE: deficit=HEART, ascending, root 6     │
│  12:14  PRESCRIBE → ENTRAIN: 528 Hz, crossfade 4s                │
│  11:32  EVALUATE → ASSESS: ADVANCE (TCS +18, slope +0.3)         │
│  11:32  prior: 396 Hz GUT root 3, duration 142s, peak TCS 64     │
│  09:30  ASSESS → PRESCRIBE: first frequency, anchor = -0.12      │
│  09:30  BASELINE complete, anchor stored, direction ASCENDING    │
│  08:00  STARTUP → BASELINE: all gates passed                     │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation notes:**
- Canvas-based plots redraw at 10 Hz (more than enough, less GPU strain)
- Transition log scrolls upward, newest at top
- All numeric values update at 1 Hz from the coherence engine
- Color coding: GUT = warm orange, HEART = green, HEAD = cool blue
- TCS gauge changes color from red (< 40) → yellow (40-70) → green (> 70)
- Mobile layout: panels stack vertically, plots shrink to fit screen width

---

## 6. Build Order (Critical — read this carefully)

The temptation is to build everything before testing anything. Resist. Here's the order that lets you test incrementally and *see* progress at every step.

### Phase 1 — Sensors and visibility (build this first, all of it works without any policy)
1. `index.html` shell with two big "Connect" buttons
2. `streams/event-bus.js`
3. `sensors/polar-h10.js` — get the H10 streaming, console.log the raw data
4. `sensors/muse-athena.js` — same for the Muse
5. `viz/signal-panel.js` + `viz/plot-base.js` — see the raw waveforms live on screen

**Milestone 1:** You can put on both sensors, click connect, and watch your own ECG and EEG draw live. *Nothing else exists yet, but this alone is satisfying and proves the foundation.*

### Phase 2 — Math and features
6. `math/fft.js`, `math/filters.js`, `math/stats.js`, `math/hilbert.js`
7. `features/respiration.js`
8. `features/heart-features.js` — verify against a known HRV calculation tool with the same R-R data
9. `features/gut-features.js`
10. `features/head-features.js`
11. `features/feature-engine.js`
12. `viz/feature-panel.js`

**Milestone 2:** All derived features displayed live alongside raw signals. Validate against the four known states (eyes-closed, paced breathing, mental math, box breathing) from Doc 2 §9.

### Phase 3 — Coherence
13. `coherence/regime-scoring.js`
14. `coherence/cross-regime.js`
15. `coherence/tcs.js`
16. `coherence/coherence-vector.js`
17. `viz/coherence-panel.js`

**Milestone 3:** TCS gauge updates live during sessions. Sit and meditate, watch it climb. No audio yet — this proves the measurement side is real before we trust the policy side.

### Phase 4 — Delivery
18. `delivery/audio-binaural.js` — make it play a tone, any tone, on command
19. `delivery/haptic-woojer.js` — verify Woojer responds (BT vs wired test goes here)
20. `delivery/heartbeat-signature.js`
21. `config/frequencies.json` — load the 27-frequency library
22. `delivery/delivery-coordinator.js`

**Milestone 4:** Manual frequency selection from a dropdown plays through binaural + Woojer. Test the heartbeat end-signature in isolation. Verify no audio-haptic desync.

### Phase 5 — Policy (the brain)
23. `policy/arousal-anchor.js`
24. `policy/selection-rules.js`
25. `policy/evaluate-rules.js`
26. `config/policy.json` — all tunable thresholds
27. `policy/state-machine.js`
28. `policy/prescription.js`
29. `viz/state-panel.js`

**Milestone 5:** Full closed loop running. The system selects frequencies based on your live coherence and transitions through states automatically. Sit down, run a session, watch the dashboard. *This is the moment the test app becomes the system.*

### Phase 6 — Recording and replay
30. `recording/session-recorder.js`
31. `recording/session-replay.js`
32. `recording/session-report.js`

**Milestone 6:** Sessions are saved as JSON, can be replayed offline through the policy engine for threshold tuning. The system can now learn from itself.

---

## 7. Validation Protocol — The First Real Sessions

Before trusting any prescription decision, run these test sessions in order:

**Test 1 — Sensor sanity (Phase 1 complete):**
- Put on H10 + Muse, connect both, sit still for 60 s
- Verify ECG looks like ECG, EEG channels all show contact, no flatlines
- Move your head gently — IMU should respond, EEG should show motion artifact
- Eyes open / eyes closed — should see clear alpha rise on closing

**Test 2 — Feature accuracy (Phase 2 complete):**
- Paced breathing at 6 breaths/min (0.1 Hz) for 3 minutes
- Verify HRV coherence climbs to a sharp peak near 0.1 Hz
- Verify HF power dominates LF
- This is the canonical HRV biofeedback signal — if it doesn't move correctly, the math is wrong

**Test 3 — Known state coherence (Phase 3 complete):**
- Repeat the four states from Doc 2 §9: resting eyes-closed, paced breathing, mental arithmetic, box breathing
- Verify TCS responds in the expected direction for each
- If TCS doesn't move correctly under known stimuli, fix the math before trusting the policy

**Test 4 — Manual delivery (Phase 4 complete):**
- Play each of the 27 frequencies manually for 30 s each
- Confirm binaural is producing the correct difference frequency (use a tone analyzer if uncertain)
- Confirm Woojer is delivering haptic at the right frequency or correct sub-octave
- Test the heartbeat end-signature in isolation — does it feel right?

**Test 5 — First closed-loop session (Phase 5 complete):**
- Full session, eyes closed, comfortable seated position
- Don't try to guide it. Let the system drive.
- Watch the dashboard for any obviously wrong decisions
- Note in the transition log when the system made a choice you would not have made
- Save the session

**Test 6 — Replay tuning (Phase 6 complete):**
- Take the session from Test 5 and replay it with different `flip_margin` values
- See which value would have made better decisions
- Update `policy.json` and repeat

---

## 8. Tunable Configuration

Everything tunable lives in `config/policy.json` so you never have to touch code to refine the system:

```json
{
  "baseline_duration_sec": 90,
  "entrain_min_duration_sec": 30,
  "entrain_max_duration_sec": 180,
  "tracking_interval_sec": 1,
  "flip_margin": 0.15,
  "advance_tcs_delta_threshold": 15,
  "advance_plateau_tcs_threshold": 70,
  "pivot_low_plateau_tcs_threshold": 50,
  "decline_from_peak_threshold": 10,
  "session_max_duration_sec": 1800,
  "goal_tcs_threshold": 80,
  "goal_sustain_duration_sec": 60,
  "hug_min_duration_sec": 45,
  "hug_peak_lost_grace_sec": 3,
  "no_repetition_window": 5,
  "tcs_weights": {
    "gut": 0.20,
    "heart": 0.20,
    "head": 0.20,
    "triune_plv": 0.25,
    "harmonic_lock": 0.15
  }
}
```

The 27-frequency library lives in `config/frequencies.json`:

```json
[
  {
    "frequency_hz": 174,
    "regime": "GUT",
    "digital_root": 3,
    "solfeggio_name": "Foundation",
    "octave_class": 1
  },
  {
    "frequency_hz": 285,
    "regime": "GUT",
    "digital_root": 6,
    "solfeggio_name": "Quantum Cognition",
    "octave_class": 1
  }
  // ... 25 more
]
```

Joseph maintains both files. Editing either one and reloading is enough to retune the system.

---

## 9. What Claude Code Should Build First

When you hand this off to Claude Code, the right first prompt is:

> "Build Phase 1 of the Aetheria Coherence Lab as specified in Doc 4. That means: index.html shell with connect buttons, streams/event-bus.js, sensors/polar-h10.js, sensors/muse-athena.js, viz/plot-base.js, viz/signal-panel.js, and a minimal main.js that wires them together. Use Web Bluetooth for both sensors. Confirm at the end that I should be able to open the page, click connect on both sensors, and see live ECG and EEG waveforms drawing on the screen. Do not build features, coherence, policy, or delivery yet — those are later phases."

Then test Milestone 1 before moving on. Then prompt for Phase 2. Each phase is one focused build session for Claude Code, one milestone test for you. This keeps the work bounded and the feedback loop tight.

---

## 10. Reusability — The Long Game

Once the lab is working, here's how its modules propagate into the rest of the Aetheria ecosystem:

- **Sophia Ultra** wants coherence-aware responses → import `coherence/coherence-vector.js` and `features/feature-engine.js`, hook them to its existing Muse connection. Sophia now knows the user's biofield state in real time.
- **Quantum Frequency Engine** wants adaptive prescription → import `policy/state-machine.js` and `delivery/audio-binaural.js`. The QFE becomes a closed-loop system instead of a manual one.
- **Prema Amara** wants to display the user's coherence during chat → import `viz/coherence-panel.js` and the coherence engine. The mystical interface gets a real biofield readout.
- **Future Aetheria book companion app** wants to validate that readers are entraining as they read → import the whole stack as a background service.

None of these integrations require rewriting any module. The lab is the seed, and everything else inherits.

---

**End of Doc 4. Combined with Docs 1, 2, and 3, this is the complete buildable specification for the Aetheria adaptive closed-loop system.** Hand all four documents to Claude Code and Phase 1 begins.
