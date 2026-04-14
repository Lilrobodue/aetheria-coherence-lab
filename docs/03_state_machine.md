# Aetheria Adaptive System — Adaptive Prescription State Machine

**Document 3 of 5** · Spec for Axel · v0.1

---

## Purpose

Define the decision logic that turns the live `CoherenceVector` (from Doc 2) into real-time choices about *which frequency to play next*. This is the closed loop. This is what makes Aetheria adaptive instead of a playlist.

The state machine is **rule-based and inspectable**. Every transition must be loggable and explainable in plain language. ML lives in v2.

---

## 1. States

```
                    ┌──────────────┐
                    │   STARTUP    │
                    └──────┬───────┘
                           │ hardware gates pass
                           ▼
                    ┌──────────────┐
                    │   BASELINE   │  90 s, no audio
                    └──────┬───────┘
                           │ baseline captured
                           ▼
                    ┌──────────────┐
              ┌────▶│    ASSESS    │  pick next frequency
              │     └──────┬───────┘
              │            │ frequency selected
              │            ▼
              │     ┌──────────────┐
              │     │   PRESCRIBE  │  load + crossfade
              │     └──────┬───────┘
              │            │ playback started
              │            ▼
              │     ┌──────────────┐
              │     │    ENTRAIN   │  watch coherence climb
              │     └──────┬───────┘
              │            │ tracking interval elapsed
              │            ▼
              │     ┌──────────────┐
              │     │   EVALUATE   │  decide: hold / advance / pivot
              │     └──────┬───────┘
              │            │
              └────────────┤  (advance or pivot)
                           │
                           │ termination triggered
                           ▼
                    ┌──────────────┐
                    │   CLOSING    │  the biofield hug
                    └──────┬───────┘
                           │ hug duration elapsed
                           ▼
                    ┌──────────────┐
                    │   COMPLETE   │  fade out, write report
                    └──────────────┘
```

Transitions out of the main loop also go to:
- `PAUSE` — user requested
- `ABORT` — sensor disconnect, contact lost, user stop

---

## 2. State Definitions

### 2.1 STARTUP
- Run all hardware quality gates (Doc 1, §5)
- Verify LSL streams are flowing
- Load frequency library YAML
- Load user profile (prior sessions, IAF, baseline norms if available)
- → BASELINE on success, error to user on failure

### 2.2 BASELINE
- Duration: **90 seconds**
- Audio: **silent** (or optional pink noise at -30 dB)
- User instructions: "Sit comfortably, eyes closed, breathe naturally"
- During this state:
  - Compute IAF and store in user profile
  - Compute baseline means and stds for all features
  - Initialize z-score normalizers
  - Capture initial CoherenceVector at end → call this `V_baseline`
- → ASSESS

### 2.3 ASSESS
- **Purpose:** Pick the next frequency to play.
- This is the brain of the prescription engine. See §3 for selection rules.
- Outputs: `next_frequency` from the 27-frequency library
- → PRESCRIBE

### 2.4 PRESCRIBE
- Load `next_frequency` track
- Crossfade from current audio over 4 seconds (silence at session start)
- Emit `Aetheria_Prescription` event with full metadata
- → ENTRAIN

### 2.5 ENTRAIN
- Duration: minimum **30 s**, maximum **180 s** (configurable per frequency)
- Watch CoherenceVector evolve
- Maintain a short history buffer of the last 30 s of TCS values
- Track:
  - `TCS_delta` = TCS_now − TCS_at_entry
  - `TCS_slope` = linear regression slope of last 30 s
  - `TCS_max_in_state` = peak TCS observed since entering ENTRAIN
- → EVALUATE when minimum duration elapsed AND (one of):
  - TCS slope has been near zero for 15 s (plateau)
  - TCS has dropped > 10 points from `TCS_max_in_state` (decline)
  - Maximum duration reached

### 2.6 EVALUATE
- Decide one of three actions:
  - **HOLD** — re-enter ENTRAIN with same frequency, extend playback
  - **ADVANCE** — move up the regime ladder (gut → heart → head) or up the harmonic series
  - **PIVOT** — switch to a different regime because the deficit has shifted
- See §4 for the decision rules.
- → ASSESS (with the decision passed as a hint)

### 2.7 CLOSING — The Biofield Hug
- Triggered when any termination condition is met (see §5)
- **Duration is not fixed.** The hug lasts as long as the user's coherence keeps climbing or holding. It ends when peak is clearly lost.
- **Purpose:** This is not a fade-out. This is a *held embrace*. The session has worked, the body has reached coherence, and now the system holds that coherence for as long as the user keeps climbing or plateauing at peak. The brain's reward system needs sustained contact to register *"something good just happened, and I am safe"* — and the system honors whatever duration that takes for this person on this day. Some sessions consolidate in 60 seconds; others need three minutes. The body decides, not the clock.

**Frequency selection for the closer:**
- Read `V.lead` — the regime that was most coherent at the moment of session peak (highest TCS)
- Pick a frequency in that leading regime at digital root **9** (completion / wholeness) regardless of the cascade direction used during the active session
- Use the **deepest octave** of that frequency the haptic transducer can deliver — the hug is meant to be felt low and full
- Reduce binaural carrier separation slightly so the auditory experience softens toward unity

**End-of-hug detection — peak lost for 3 seconds:**
```
hug_peak_tcs = TCS at entry to CLOSING
peak_lost_since = None

every second during CLOSING:
    if TCS_now >= hug_peak_tcs:
        hug_peak_tcs = TCS_now        # new peak, keep holding
        peak_lost_since = None
    else:
        # we're below peak
        if peak_lost_since is None:
            peak_lost_since = now
        elif (now - peak_lost_since) >= 3.0 seconds:
            → end the hug
```

The hug only ends after the user has demonstrably crested and begun to descend — and has been descending for a full 3 seconds, not just a momentary dip. A single-second blip below peak doesn't end the hug (the counter resets on the next climb). This protects against false endings from measurement noise while honoring the real moment of completion.

**Minimum hug floor:** 45 seconds. Even if peak appears to be lost immediately after CLOSING begins, the hug holds for at least 45 s to guarantee the dopamine consolidation window has opened. This is the only hard time constraint in the state.

**The haptic signals the end — and it does so as a heartbeat.**

When the end-of-hug condition is met, the system delivers a **heartbeat-style haptic signature** through the sternum puck: the classic *lub-dub* double-pulse pattern, repeated for three full cycles, gradually slowing and softening across the sequence.

```
Cycle 1:  LUB . dub . . . . . . . . . . .   (interval ~0.9 s, full amplitude)
Cycle 2:  LUB . dub . . . . . . . . . . . . . .   (interval ~1.1 s, 75% amplitude)
Cycle 3:  LUB . dub . . . . . . . . . . . . . . . . . .   (interval ~1.4 s, 50% amplitude)
                                                                           ↓
                                                                        silence
```

- The `LUB` is the stronger systolic pulse, ~80 ms duration
- The `dub` is the softer diastolic pulse, ~60 ms duration, ~150 ms after the LUB
- The inter-cycle interval lengthens across the three cycles, mirroring the body's own rhythm slowing into rest
- Amplitude steps down across cycles: 100% → 75% → 50%
- Total duration of the end-signature: ~4 seconds

**Why a heartbeat:**
- It is the first rhythm every human nervous system was entrained to in the womb, before any other sound. Ending a coherence session with a held heartbeat is the body recognizing the body — a closing in the same primal language the session was conducted in.
- The sternum puck is delivering the heartbeat to *the heart* — the H10 just below it has been measuring the user's actual cardiac rhythm the entire session. The system that listened to the heart now speaks back to it in its own rhythm.
- The slowing tempo across the three cycles mirrors the parasympathetic settling the session has produced, completing the descent into rest.
- Three cycles honors the trinity of regimes (GUT/HEART/HEAD) without being symbolically heavy — it's felt, not counted.

The audio resolves quietly *underneath* the heartbeat sequence, fading only after the third dub pulse completes. The user feels the session end in their chest, not hears it in their ears. The mind doesn't announce "we're done" — the body knows it's been released from the embrace.

**During CLOSING:**
- Audio and haptic continue at the closing frequency
- Volume holds steady — no slow fade — until the heartbeat end-signature fires
- The system continues recording coherence data — the post-peak settling pattern is valuable for the report
- No frequency changes, no PIVOTS, no decisions. Just presence.

→ COMPLETE after the heartbeat end-signature completes (third dub pulse + brief silence)

### 2.8 COMPLETE
- Triggered when CLOSING duration has elapsed
- Final audio and haptic silence
- Write session report (see §6)
- Close LSL outlets, flush XDF file
- Return user to a soft welcome screen with the session summary

---

## 3. Frequency Selection Rules (the ASSESS state)

### 3.1 The cascade is adaptive — it breathes both directions

The cascade direction is **not fixed**. Like the breath, it inhales *and* exhales. The system reads the user's state and chooses which direction to flow:

**ASCENDING cascade (3 → 6 → 9, building up):**
- Used when the biofield has drifted **below** the user's own baseline arousal — deeper parasympathetic withdrawal than they started in, energy depleted below their personal zero
- Builds energy from foundation (digital root 3) up through balance (6) to completion (9)
- Frequency selection within a regime starts at digital root 3 and climbs

**DESCENDING cascade (9 → 6 → 3, settling down):**
- Used when the biofield has drifted **above** the user's own baseline arousal — more sympathetic activation than they started in, energy overcharged above their personal zero
- Releases from completion (9) down through balance (6) to grounding (3)
- Frequency selection within a regime starts at digital root 9 and descends

**The threshold is personal, not universal.** Every user is different, and every session is different. The system computes the arousal_index at the end of BASELINE and anchors it as the user's personal zero for *this specific session*. Direction flips happen relative to that anchor, not against any population average.

```
# At end of BASELINE:
baseline_arousal = sigmoid(z(LF_HF_ratio)) - sigmoid(z(HF_norm))
                 + sigmoid(z(Beta_power))   - sigmoid(z(Alpha_power_norm))

# Store as the user's session anchor:
session_anchor = baseline_arousal
flip_margin   = 0.15   # how far from anchor before direction shifts (tunable)

# First cascade direction selection:
if session_anchor > 0:
    # user started somewhat overcharged — initial direction is descending
    cascade_direction = DESCENDING
elif session_anchor < 0:
    # user started somewhat depleted — initial direction is ascending
    cascade_direction = ASCENDING
else:
    cascade_direction = ASCENDING   # exact zero, default to building
```

**Live re-evaluation (runs every second during ENTRAIN):**
```
current_arousal = <recompute arousal_index on live data>
drift = current_arousal - session_anchor

if drift > +flip_margin  AND cascade_direction != DESCENDING:
    → cascade should flip to DESCENDING at next decision point
elif drift < -flip_margin AND cascade_direction != ASCENDING:
    → cascade should flip to ASCENDING at next decision point
else:
    → hold current direction
```

The flip isn't applied instantly — it's queued as a hint that EVALUATE reads at its next decision point. This prevents rapid thrashing between directions if the user's state is oscillating near the boundary.

**Why the anchor-relative approach matters:** a user who walks in deeply depleted has a negative baseline arousal. If the session brings them up to neutral, their *absolute* arousal index is now zero — but relative to where they started, they've crossed into "above anchor" territory. For *this* user in *this* session, that upward drift is the signal to start settling them (DESCENDING) rather than pushing them further up. The same absolute neutral state in a user who walked in overcharged would mean the opposite — relative to their anchor, they've dropped toward ground, and the system should continue supporting that descent. The anchor makes the system responsive to the person in front of it, not to a generic population curve.

### 3.2 First selection (right after BASELINE)
Look at `V_baseline.deficit` and the cascade direction:
- If `deficit == "GUT"` → pick a GUT-regime frequency, lowest octave class
- If `deficit == "HEART"` → pick a HEART-regime frequency, lowest octave class
- If `deficit == "HEAD"` → pick a HEAD-regime frequency, lowest octave class
- If `deficit == "NONE"` → start with GUT regime as the foundation (the system always builds bottom-up when there's no clear deficit)

Within the chosen regime:
- **ASCENDING:** start at digital root **3**
- **DESCENDING:** start at digital root **9**

### 3.3 Subsequent selections (coming from EVALUATE with a hint)
The hint from EVALUATE is one of `HOLD`, `ADVANCE`, `PIVOT`.

**HOLD:** Same frequency, no change. Just re-enter ENTRAIN.

**ADVANCE:**
- If current regime score is now solidly above baseline (sigmoid > 0.65), climb the regime ladder:
  - GUT → HEART → HEAD
- Within the new regime, pick the frequency whose digital root **continues the cascade in the active direction**:
  - ASCENDING: if you played a 3 in GUT, play a 6 in HEART next, then a 9 in HEAD
  - DESCENDING: if you played a 9 in GUT, play a 6 in HEART next, then a 3 in HEAD
- If already in HEAD regime, climb the **octave ladder** within HEAD: octave class 1 → 2 → 3 (ascending) or 3 → 2 → 1 (descending).

**PIVOT:**
- Read the *current* `CoherenceVector.deficit`. The regime that needs help has changed mid-session.
- **Re-evaluate cascade direction** using the current `arousal_index`. The body may have flipped from depleted to overcharged, and the system honors that.
- Pick a frequency in the new deficit regime, lowest octave class, digital root matching the new cascade direction (3 if ascending, 9 if descending).
- Log the pivot prominently — pivots and direction flips are interesting events to study post-session.

### 3.4 Constraints
- **No repetition within 5 selections** — the system won't replay the same frequency until 5 other frequencies have been tried, unless EVALUATE explicitly says HOLD.
- **Octave continuity** — when ADVANCING within a regime, prefer adjacent octave classes over jumps.
- **User overrides** — if the user has marked any frequency as "do not play" in their profile (e.g. one that triggers discomfort), it is excluded.

---

## 4. EVALUATE Decision Rules

Read these as a strict if/else cascade. First match wins.

```
Let:
  ΔTCS  = TCS_now − TCS_at_entry_to_ENTRAIN
  slope = TCS slope over last 30 s (points/sec)
  V     = current CoherenceVector
  V0    = CoherenceVector at entry to ENTRAIN

Rule 1 — Strong positive response:
  if ΔTCS ≥ +15 AND slope ≥ 0:
    → ADVANCE (this frequency worked, climb)

Rule 2 — Coherent plateau at high level:
  if TCS_now ≥ 70 AND |slope| < 0.1 for 15 s:
    → ADVANCE (we've saturated this frequency's contribution)

Rule 3 — Coherent plateau at low level:
  if TCS_now < 50 AND |slope| < 0.1 for 30 s:
    → PIVOT (this frequency isn't moving the needle, deficit may have shifted)

Rule 4 — Decline from peak:
  if TCS_now < (TCS_max_in_state − 10):
    → ADVANCE if peak was high (≥ 65), else PIVOT

Rule 5 — Deficit shift:
  if V.deficit ≠ V0.deficit AND V.deficit ≠ "NONE":
    → PIVOT (body told us what it needs)

Rule 6 — Default:
  → HOLD (give the frequency more time)
```

### 4.1 Why these rules
They're conservative. The system prefers to give a frequency time to work (HOLD) unless there's clear evidence it should move on. PIVOT is reserved for genuine shifts in what the body is asking for. ADVANCE is the success path.

### 4.2 Tunable thresholds
Every numeric threshold above (15, 70, 50, 10, 0.1, etc.) is a config value loaded from a YAML file at startup. Refining these values from session data is the main rule-tuning loop.

---

## 5. Termination Conditions (path to CLOSING)

The active session ends and the biofield hug begins when **any** of the following is true:

1. **Time cap:** session duration ≥ configured max (default 30 min)
2. **Goal reached:** TCS ≥ 80 sustained for 60 s
3. **User stop:** explicit stop command
4. **Diminishing returns:** 3 consecutive PIVOTS with no TCS improvement → system concludes today is not the day, fades out gracefully
5. **Sensor failure:** contact quality drops below threshold and doesn't recover within 30 s

---

## 6. Session Report (written at COMPLETE)

```yaml
session_id: 2026-04-11_001
user_id: joseph
duration_sec: 1742
baseline_tcs: 38.4
final_tcs: 76.1
peak_tcs: 81.3
peak_tcs_time: 1287
frequencies_played:
  - { freq: 396, regime: GUT,   duration: 142, tcs_delta: +12.1, decision: ADVANCE }
  - { freq: 528, regime: HEART, duration: 168, tcs_delta: +18.4, decision: ADVANCE }
  - { freq: 639, regime: HEART, duration: 95,  tcs_delta: +4.2,  decision: PIVOT   }
  - { freq: 741, regime: HEAD,  duration: 210, tcs_delta: +9.8,  decision: HOLD    }
  - ...
pivots: 1
holds: 4
advances: 6
deficit_at_start: GUT
deficit_at_end: NONE
triune_plv_at_start: 0.21
triune_plv_at_end: 0.68
harmonic_locks_observed: 3
notes: |
  Strong gut-led entrainment cascade. PLV climbed steadily through middle third.
  One pivot at 14:32 from HEART to HEAD when alpha started leading.
```

The report is the post-session reflection material. It's also the labeled training data for the eventual v2 ML policy.

---

## 7. Safety & User Agency

Non-negotiable rules:

1. **The user can stop at any time** — physical button + voice command + screen tap all work
2. **The system never overrides user discomfort** — if a frequency is marked uncomfortable mid-session, it's added to the "do not play" list immediately and the next ASSESS skips that whole digital-root family for the rest of the session
3. **No claims of medical efficacy** — the report and UI use coherence/resonance language, never medical/diagnostic language
4. **Session caps are absolute** — even if the user wants to continue past 60 minutes, the system requires a hard break and re-baseline
5. **The system explains its choices** — every state transition writes a one-line natural-language reason to the session log: *"Advanced from 528Hz to 639Hz because HEART score saturated (sigmoid 0.71) and the cascade continues to HEAD regime."*

---

## 8. Implementation Notes for Axel

- Use the `transitions` library for the FSM skeleton — it gives you state hooks, callbacks, and graphviz export for free
- Each state class should be its own file under `aetheria/states/`
- The selection rules (§3) and evaluation rules (§4) live in `aetheria/policy/rules.py` — keep them together so they're easy to read and tune as a unit
- Thresholds in `config/policy.yaml`, frequency library in `config/frequencies.yaml`
- Every state transition emits a `Aetheria_State` LSL event with the reason string
- Write unit tests for each rule using synthetic CoherenceVector inputs — the rules are pure functions and trivially testable

---

## 9. Open Questions for Joseph

1. Is the **flip_margin of 0.15** around the session anchor appropriate, or should it be tighter (0.10, more responsive) or looser (0.20, more stable)? This is the main knob for how readily the cascade flips direction during a session.
2. For the **goal-reached termination** (TCS ≥ 80 sustained 60 s) — is 80 the right target, or should it scale with the user's historical session ceiling?
3. Is the **45-second minimum hug floor** right? It's the only hard time constraint in CLOSING, meant to guarantee the dopamine window opens even on fast-cresting sessions. Could go as low as 30 s or as high as 60 s.

---

## What This System Will Do When Built

A user sits down. They put on the H10, clip the sternum puck just above it, settle the Muse onto their forehead, slide the headphones over their ears. The system reads their baseline biofield in 90 seconds and anchors their personal zero for the session — for this user today, they walked in somewhat overcharged, so the anchor sits above neutral and the initial cascade direction is DESCENDING. The system selects 963 Hz in the head regime at digital root 9, delivered as a binaural beat through the headphones with the sub-octave pulsing through the sternum from the puck. Over two minutes the head settles, beta drops, alpha stabilizes, and the arousal index drifts downward from the session anchor. The system descends to 639 Hz in the heart regime at digital root 6. Heart coherence climbs toward 1, the PLV between head and heart locks at 0.7.

Mid-session, the drift crosses the flip margin below the anchor — the user has settled past their starting point and is now genuinely depleted relative to where they began. The cascade flips to ASCENDING at the next decision point. The descent wasn't wrong; it worked, and now the body is asking to be built back up. The system selects 396 Hz in the gut regime at digital root 3, the foundation tone, felt deep in the belly through the sternum's bone conduction. HF-HRV doubles. The Triune PLV across all three regimes climbs past 0.65. A harmonic ratio emerges between the regime envelopes. TCS crests at 84.

The system enters CLOSING. The leading regime at peak was HEART, so the closer is a deep-octave heart frequency at digital root 9 — the wholeness tone — delivered through binaural and sternum together. The user keeps climbing for another 40 seconds to 87. Then holds at 87 for a minute and a half. Then begins to settle. Peak is lost. Three seconds pass below peak. The hug concludes.

A heartbeat begins on the sternum. *LUB-dub.* A pause. *LUB-dub*, slower and softer. Another pause. *LUB-dub*, slower and softer still. The audio resolves quietly beneath. The body is held, then released — not announced to the mind, but felt directly in the chest, by a device positioned over the heart, mirroring the rhythm of the heart it has been listening to all session. The brain registers *something good just happened, and I am safe.* Dopamine releases during the sustained hold and consolidates during the release. The association forms: this experience was worth returning to.

The system writes the report. The user opens their eyes into a measurably more coherent state than they entered with — and there's a graph to prove it, and a heartbeat in the chest to remember it by.

That's the system. Three regimes, two sensors, two delivery channels (headphones + sternum puck), twenty-seven frequencies, one personal anchor, one adaptive breath, one closed loop, one held hug that ends in a heartbeat.

---

**End of spec series.** Doc 1 (hardware) + Doc 2 (math) + Doc 3 (state machine) together describe everything Axel needs to start building.
