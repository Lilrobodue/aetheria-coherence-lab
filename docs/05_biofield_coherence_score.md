# Aetheria Adaptive System — Biofield Coherence Score (BCS)

**Document 5 of 5** · Spec for Axel & Claude Code · v0.1
**Status:** The proof layer. Built last, after Docs 1-4 are working.

---

## 1. Why This Document Exists

Docs 1 through 4 specify a complete adaptive closed-loop entrainment system. When those four docs are implemented and working, you have a functional Aetheria: sensors in, coherence measured, frequencies adaptively prescribed, biofield hug delivered, sessions recorded.

**This document adds one thing: the proof.**

The Triune Coherence Score (TCS) from Doc 2 is the *operational* score — the number the policy engine reads every second to decide what to play next. It tells the system "is this working right now."

The Biofield Coherence Score (BCS) defined here is the *truth* score — a deeper, slower measurement of whether the three regimes are actually unifying into one field, the way the Unified Lewis Framework predicts they should.

Both numbers belong in the system. They serve different purposes. TCS drives the loop. BCS validates the framework.

---

## 2. The Conceptual Difference

**TCS asks:** "How well is each regime doing, and are they coordinated?"
- Computed as a weighted sum of per-regime scores plus phase-locking plus harmonic ratio detection
- Fast (~50 ms per update at 1 Hz)
- Drives moment-to-moment policy decisions
- Already specified in Doc 2

**BCS asks:** "How much does the data from all three regimes look like it's coming from one organized field, versus three independent systems happening to be near each other?"
- Computed using techniques that detect *generative unity* — whether one underlying pattern explains all three regimes
- Slower (~200-300 ms per update, runs every 10-15 seconds)
- Reported at session end as the deeper answer to "did this work"
- This document specifies it

The two scores complement each other. TCS is the steering wheel. BCS is the destination indicator.

---

## 3. The Three Components of BCS

BCS combines three established mathematical techniques, each measuring biofield unity in a different way. Each is bounded 0 to 1. A unified field scores high on all three; an unrelated collection of signals scores low. The three together are robust against any single false-positive pathway.

### 3.1 Kuramoto Order Parameter — Phase Unity

From Yoshiki Kuramoto's coupled oscillator theory. The canonical mathematical measurement of "how much does this collection of oscillating things behave as one thing."

**Inputs:** the instantaneous phase φᵢ(t) of each regime envelope (gut, heart, head), already computed via Hilbert transform from Doc 2 §5.

**Formula:**
```
R(t) = | (1/N) × Σᵢ exp(i × φᵢ(t)) |
```

Where N = 3 (the three regimes). R(t) ranges from 0 (random phases) to 1 (perfect phase lock). Compute R over a 60-second window and take the mean:

```
kuramoto_R = mean(R(t)) over the 60s window
```

**What it captures:** Whether the three regimes are oscillating *as one* in the temporal dimension. This is the most direct measurement of phase unity.

**Distinct from PLV (in Doc 2):** PLV measures pairwise phase coupling. Kuramoto measures *collective* phase unity across all three at once. A system can have high pairwise PLVs but still have a low Kuramoto value if the three phases form a stable triangle rather than collapsing onto one direction. Kuramoto is stricter and more meaningful for the unified-field claim.

### 3.2 Shared Mode Energy Fraction — Generative Unity

From Multivariate Empirical Mode Decomposition (MEMD). This is the heart of BCS — the technique that most directly tests the "one underlying field expressing itself in three places" claim.

**The intuition:** EMD decomposes a signal into intrinsic mode functions (IMFs), each representing one oscillatory rhythm present in the data. Standard EMD does this for one signal at a time. **Multivariate EMD does it for several signals simultaneously**, finding modes that exist *across all of them at the same frequencies*. If three signals share many modes, they're expressions of overlapping underlying processes. If they share few or none, they're independent.

**Inputs:** the three regime envelopes (gut, heart, head) over the 60-second window, resampled to a common 4 Hz grid.

**Algorithm (high level):**
1. Run MEMD on the three-channel signal, producing a set of multivariate IMFs
2. For each IMF, compute its energy contribution to each channel
3. An IMF is "shared" if it carries non-trivial energy (>10% of channel total) in all three channels
4. Compute total energy in shared IMFs versus total signal energy

**Formula:**
```
shared_energy_fraction = Σ_shared_IMFs(energy) / Σ_all_IMFs(energy)
```

Bounded 0 (no shared modes) to 1 (all energy lives in shared modes).

**What it captures:** The extent to which the three regimes are expressions of common underlying oscillatory processes. This is *generative* unity rather than just temporal correlation. It tests the framework's central claim directly.

**Implementation note:** MEMD has no off-the-shelf JavaScript library. The algorithm needs to be ported from the published reference (Rehman & Mandic, 2010, "Multivariate Empirical Mode Decomposition"). It's the most complex piece of math in the entire Aetheria system, but it's a finite, well-specified algorithm — perhaps 300-400 lines of JavaScript. Claude Code can implement it from the paper.

### 3.3 Normalized Mutual Information — Informational Unity

From information theory. Measures how much knowing one regime's state reduces uncertainty about the others, capturing both linear and nonlinear relationships.

**Inputs:** the three regime envelopes over the 60-second window.

**Algorithm:**
1. For each pair of regimes (gut-heart, heart-head, gut-head), compute mutual information using a histogram-based estimator with adaptive binning (e.g. Freedman-Diaconis rule for bin width)
2. Normalize each pairwise MI by the joint entropy to get values bounded 0 to 1
3. Average the three pairwise normalized MIs

**Formula:**
```
nMI(X, Y) = MI(X, Y) / H(X, Y)
where MI(X, Y) = ΣΣ p(x,y) × log(p(x,y) / (p(x) × p(y)))
      H(X, Y) = -ΣΣ p(x,y) × log(p(x,y))

mutual_info_score = mean(nMI(gut, heart), nMI(heart, head), nMI(gut, head))
```

**What it captures:** Statistical dependency between regimes that includes nonlinear coupling, which Kuramoto and PLV (both phase-based) cannot detect. If two regimes show no phase relationship but consistently rise and fall together in some nonlinear pattern, mutual information catches it.

**Why include this alongside Kuramoto:** Phase unity and statistical dependency are different mathematical properties. A system can have one without the other. Requiring both for a high BCS makes the score robust.

---

## 4. The Composite BCS

```
BCS = 100 × (
        0.40 × kuramoto_R
      + 0.35 × shared_energy_fraction
      + 0.25 × mutual_info_score
      )
```

**Why these weights:**
- Kuramoto gets the largest weight (0.40) because phase unity is the most direct and well-validated measurement of collective oscillator behavior
- Shared mode energy gets 0.35 because it's the most theoretically meaningful for the framework, but the math is the most complex and benefits from being checked against the simpler measures
- Mutual information gets 0.25 because it's the most general (catches nonlinear coupling) but also the noisiest estimator

These weights are starting values. They can be tuned from session data once the system has been running long enough to have ground truth.

**Output:** a single scalar 0 to 100, computed every 10-15 seconds during a session, published to the event bus as `Aetheria_BCS`.

---

## 5. The Phase Transition Signature

This section is the reason BCS exists.

The Unified Lewis Framework predicts that the biofield is **one thing** — not three coordinated regimes, but one toroidal pattern expressing itself across nested scales. If that's true, then when an Aetheria session successfully entrains the field, **BCS should not rise smoothly the way TCS does**. It should rise as a *phase transition* — a moment where the score jumps because the three regimes have suddenly locked into one mode.

This is the empirical fingerprint of biofield coherence as a real phenomenon, distinct from incremental improvements in individual regime scores.

**What to look for in session recordings:**
- TCS climbs gradually as frequencies entrain each regime — this is expected and happens every session
- BCS may rise slowly at first, then **jump** by 15-30 points within a 30-60 second window
- The jump should be coincident with a peak in TCS, but distinct from it — TCS reflects the climb, BCS reflects the moment of unification
- After the jump, BCS plateaus at the elevated level for the remainder of peak coherence
- The jump should be reproducible across sessions for the same user under similar conditions

**If the phase transition appears consistently:** the framework has its first quantitative empirical signature. This is a major scientific result.

**If the phase transition does not appear:** the system is still a valuable adaptive entrainment tool, and the BCS provides a continuous measurement of biofield unity that can guide further refinement of both the hardware and the framework. Either outcome is meaningful.

**If the phase transition appears in some sessions but not others:** even more interesting — the conditions that produce it become a research question. What was different about the sessions where the field unified versus the sessions where it didn't? This is where the Aetheria system becomes a tool for advancing the framework rather than just demonstrating it.

---

## 6. Where BCS Lives in the System

**BCS does not drive the closed-loop policy.** The state machine in Doc 3 reads only TCS and the CoherenceVector. BCS is purely *observational* — it watches the session unfold and reports its findings, but it doesn't make decisions.

**This is intentional.** The closed loop needs to respond at 1 Hz with fast, well-understood math. BCS is slower and uses techniques (especially MEMD) that have computational cost and potential edge cases. Keeping it out of the control path means BCS can be experimented with, refined, and even temporarily disabled without affecting whether the system works.

**Where BCS appears in the system:**
1. **Live dashboard:** a small BCS panel next to the TCS gauge, updating every 10-15 seconds. Color-coded the same way (red < 40, yellow 40-70, green > 70). Optionally with a small graph showing BCS over the session.
2. **Session report:** BCS at start, BCS at peak, BCS at end, and **a flag indicating whether a phase transition was detected** (defined as a 15+ point jump in any 60 second window).
3. **Replay:** when replaying a recorded session, BCS is recomputed. Threshold tuning sessions can compare TCS-driven decisions against BCS outcomes to see whether the closed loop produced field unification.

---

## 7. Module Additions to the Coherence Lab

These are the new files that get added to the project layout in Doc 4 §2 when BCS is built. They live in their own folder so they're cleanly separable from the core closed-loop modules.

```
aetheria-lab/
├── bcs/
│   ├── kuramoto.js              # order parameter computation
│   ├── memd.js                  # multivariate empirical mode decomposition
│   ├── mutual-information.js    # nMI estimator with adaptive binning
│   ├── bcs-engine.js            # orchestrates the three components, publishes BCS
│   └── phase-transition.js      # detects phase transition events in BCS history
│
└── viz/
    └── bcs-panel.js              # live BCS gauge + history graph + transition flag
```

**Module interfaces:**

```javascript
// bcs/kuramoto.js
export function kuramotoOrderParameter(phaseSeriesArray) {
  // phaseSeriesArray = [gutPhases, heartPhases, headPhases]
  // returns scalar 0-1
}

// bcs/memd.js
export function multivariateEMD(channels, options) {
  // channels = [gutSignal, heartSignal, headSignal]
  // returns array of multivariate IMFs
}
export function sharedModeEnergyFraction(channels) {
  // returns scalar 0-1
}

// bcs/mutual-information.js
export function normalizedMutualInformation(x, y) {
  // returns scalar 0-1
}
export function meanPairwiseNMI(channels) {
  // returns scalar 0-1
}

// bcs/bcs-engine.js
export class BCSEngine {
  constructor(bus, config)
  start()                          // begins ~0.1 Hz computation loop
  stop()
  // Subscribes to: 'Aetheria_Features' (uses regime envelopes)
  // Publishes to:  'Aetheria_BCS' every 10-15 seconds
}

// bcs/phase-transition.js
export function detectPhaseTransition(bcsHistory) {
  // Returns { detected: bool, time: float, magnitude: float } | null
  // A transition is a 15+ point jump within any 60 second window
}
```

---

## 8. Build Order (Phase 7 of Doc 4)

BCS is **Phase 7** in the build order. It comes *after* everything in Docs 1-4 is working and validated. The closed loop must be functional and the math from Doc 2 must be trusted before BCS is added on top.

**Phase 7 — The proof layer:**
1. `bcs/kuramoto.js` (smallest, easiest to verify against synthetic phase-locked data)
2. `bcs/mutual-information.js` (moderate complexity, well-validated formulas)
3. `bcs/memd.js` (largest piece, ported from Rehman & Mandic 2010)
4. `bcs/bcs-engine.js` (orchestration, runs the three components and publishes the score)
5. `bcs/phase-transition.js` (post-hoc detector for the phase transition signature)
6. `viz/bcs-panel.js` (live dashboard panel)

**Milestone 7:** BCS is computed and displayed live during sessions, written to session recordings, and reported at session end with phase transition detection. *The system now produces both operational coherence (TCS) and truth measurements (BCS) — every session is both a healing intervention and a scientific observation.*

---

## 9. Validation Plan

Before trusting BCS as a measurement of biofield unity, validate it against known states the same way TCS was validated in Doc 2 §9:

1. **Resting eyes-closed:** expect moderate BCS (40-60 range) — some natural coupling exists at rest
2. **Paced breathing at 6 breaths/min:** expect BCS to climb noticeably as breathing imposes shared rhythm across all three regimes
3. **Mental arithmetic with body movement:** expect BCS to drop sharply — three regimes pulled in different directions
4. **Box breathing while seated:** expect BCS to climb steadily, possibly showing the phase transition signature in well-practiced users

Additional BCS-specific validation:
5. **Synthetic test:** feed three sine waves at the same frequency with random phase offsets — Kuramoto should be near 0, MEMD shared energy should be high, mutual info should be high. This isolates which component behaves how under controlled conditions.
6. **Synthetic test:** feed three independent random signals — all three components should be near 0.
7. **Synthetic test:** feed three sine waves at the same frequency with identical phase — all three components should be near 1.

If the synthetic tests pass, the math is trusted. If the four real-world tests behave directionally as expected, BCS is ready for session use.

---

## 10. What This Adds to the Aetheria Mission

Docs 1-4 give Joseph and Alisha a working adaptive entrainment system that helps people. That alone is enough — that alone is the gift.

Doc 5 gives them something additional: **a measurement instrument for the central claim of the Unified Lewis Framework**. Every session run with BCS active becomes a data point. Every phase transition observed (or not observed) is evidence. Over time, with enough sessions, the question "is the biofield real as a unified phenomenon" stops being a metaphysical claim and becomes a question that can be answered from session recordings.

That doesn't replace the felt experience. It doesn't replace the spiritual framing. It doesn't replace the love that built the system. It adds *one more language* in which the truth of the work can be expressed — the language of numbers and graphs that the scientific world speaks. The Aetheria system already speaks the language of frequency and the language of touch. With BCS, it also speaks the language of proof.

Both languages matter. The system is now bilingual.

---

**End of Doc 5. Combined with Docs 1-4, this is the complete Aetheria adaptive closed-loop system specification — operational and observational, healing and measuring, working and proving.**

---

## Summary of the Full Spec Series

- **Doc 1** — Hardware & Data Flow: the physical sensors, delivery devices, and audio routing topology
- **Doc 2** — Coherence Scoring Math: TCS and the live coherence vector that drives the closed loop
- **Doc 3** — Adaptive Prescription State Machine: how the system decides what to play, ending in the heartbeat hug
- **Doc 4** — Coherence Lab Build Spec: the HTML/JS test app that becomes the reference implementation
- **Doc 5** — Biofield Coherence Score: the truth measurement layer that validates the framework

In order, the system becomes: physically grounded (1) → mathematically scored (2) → adaptively guided (3) → buildably specified (4) → empirically validated (5).

A functional system with meaning and purpose. 💜
