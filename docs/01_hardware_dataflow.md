# Aetheria Adaptive System — Hardware & Data Flow Architecture

**Document 1 of 5** · Spec for Axel · v0.1

---

## Purpose

Define the physical sensor stack, data ingestion pipeline, and synchronization layer for the closed-loop Aetheria adaptive prescription system. This document is the foundation; the Coherence Scoring spec and State Machine spec build on top of it.

---

## 1. Sensor Stack

### 1.1 Polar H10 (Chest)
- **Role:** HEART regime (direct) + GUT regime (vagal inference)
- **Signals:**
  - Raw ECG @ 130 Hz (single lead)
  - R-R intervals @ event rate (~1 Hz average)
- **Transport:** Bluetooth Low Energy (BLE), Polar H10 GATT service
- **Why this device:** Cleanest consumer ECG available, well-validated for HRV research, supports both raw ECG stream and R-R intervals natively.

### 1.2 Muse S Athena (Head)
- **Role:** HEAD regime
- **Signals:**
  - EEG @ 256 Hz, 4 channels: TP9, AF7, AF8, TP10
  - fNIRS (HbO/HbR) over PFC, ~10 Hz
  - PPG @ 64 Hz (forehead, secondary cardiac signal)
  - IMU (accelerometer/gyro) @ 52 Hz (motion artifact rejection)
- **Transport:** BLE, Muse GATT service
- **Why this device:** Already in the Aetheria ecosystem, fNIRS adds a slow hemodynamic confirmation channel that complements fast EEG.

### 1.3 Binaural Audio Output (Aetheria player, upgraded)
- **Role:** Auditory stimulus delivery — plays the 27-frequency library binaurally
- **Delivery mode:** **Binaural beats**, not mono carrier. For each target frequency `f`, the player generates two carrier tones — one in each ear — whose difference equals `f`. Carriers are placed in the user's most sensitive hearing range (typically 200–400 Hz base), chosen per-frequency to keep both carriers comfortable.
- **Why binaural:** The brain reconstructs the difference frequency internally as a phantom tone, which engages bilateral auditory cortex and drives entrainment more effectively than a mono tone at the same frequency — especially for the lower GUT-regime frequencies that would otherwise be hard to render audibly.
- **Required hooks:** Must emit a real-time event stream containing:
  - `track_id`
  - `regime` (GUT / HEART / HEAD)
  - `frequency_hz` (the target — i.e. the binaural difference)
  - `carrier_left_hz`
  - `carrier_right_hz`
  - `digital_root` (3, 6, or 9)
  - `playback_position_ms`
  - `volume`
- **Headphone requirement:** Binaural delivery requires stereo headphones. The system must verify stereo audio routing at startup and refuse to enter BASELINE if mono is detected.

### 1.4 Haptic Output Channel — Woojer Strap 3
- **Role:** Somatic stimulus delivery — delivers each Aetheria frequency as a tactile vibration tuned to the same target frequency as the audio
- **Hardware:** **Woojer Strap 3** (purchased) — wearable torso haptic strap with proprietary Osci polymeric transducer
- **Location:** Worn across the upper chest / sternum area, sitting just above or in alignment with the Polar H10 chest strap. Single-strap form factor, adjustable fit.

- **Why the Woojer Strap 3 is the right choice:**
  - **Frequency response: ~1 Hz to 800 Hz** — vastly wider than DIY exciter alternatives. The sub-audio low end means the deepest GUT-regime sub-octaves can be delivered as pure tactile sensation, reaching body-resonance frequencies that no audio driver can produce.
  - **Centered delivery** — sits at the body's midline alongside the H10, honoring the field metaphor at the core of the Unified Lewis Framework
  - **Cardiac co-location** — the strap and the H10 occupy the same anatomical region; the heartbeat-style end-signature is delivered *to the heart by a device that knows the heart's actual rhythm*
  - **Engineered consumer product** — safety limiting, amplitude control, rechargeable battery (~6 hours), Bluetooth and 3.5mm inputs all built in. No assembly required.
  - **No hardware conflicts** — does not interfere with the Muse S Athena's behind-ear sensors, the headphones, or the H10 itself
  - **Single onboarding step** — adds one wearable to the setup the user is already preparing

- **Specs (Woojer Strap 3):**
  - Transducer: Osci polymeric haptic actuator
  - Frequency range: ~1 Hz – 800 Hz
  - Inputs: Bluetooth 5.0, 3.5mm wired
  - Battery: ~6 hours playtime, USB-C charging
  - Built-in amplifier and intensity control
  - Form factor: adjustable torso strap

- **Signal generation:** The haptic stream is generated from the same target frequency as the audio. Because the Woojer reaches down to ~1 Hz, octave-shifting is rarely needed for the lower Aetheria frequencies — the GUT-regime tones (174, 285, 396 Hz) can play at their native frequency. For the highest HEAD-regime frequencies (852, 963 Hz) that exceed the Woojer's upper limit, the haptic channel plays the **sub-octave** (frequency / 2) that lands in range while preserving the digital root. Example: a 963 Hz HEAD tone delivers 963 Hz to the ears via binaural and 481.5 Hz to the strap.

- **Transport:** **Wired 3.5mm** via a powered passive splitter with independent per-output volume controls (purchased, arriving Tuesday). The Woojer and the headphones share the host's single stereo audio output through the splitter. Bluetooth is *not* used for the Woojer in this configuration — see §1.5 for the full audio routing topology and rationale.
- **Required event stream:** Must publish to LSL with the same metadata as the audio stream, plus:
  - `haptic_frequency_hz` (may differ from audio target if octave-shifted)
  - `haptic_amplitude` (separately controllable from audio volume)
  - `transducer_id` ("woojer_strap_3")
- **Safety:** Woojer's built-in amplitude limiting handles hardware safety; software adds an additional ceiling specific to the Aetheria frequency library. Haptic delivery is opt-in per session — some users may want audio-only initially.

- **Calibration step (one-time, per user):** During first session setup, run a brief amplitude sweep through 3-4 representative frequencies and let the user set their preferred intensity. Store as part of the user profile.

- **v2 expansion path (not built in v1):** A second Woojer or pair of palm pucks held in the user's lap. This adds center + extremities, heart + hands. Defer until v1 sternum delivery is validated.

### 1.5 Audio Routing Topology

The two sensors stream over Bluetooth Low Energy (data only — no audio profile involved). The two delivery devices (headphones and Woojer Strap 3) share the host's single stereo 3.5mm output through a powered passive splitter with independent per-output volume controls. Bluetooth and the 3.5mm jack are completely independent hardware paths on any modern host, so there is zero protocol conflict.

```
                    ┌────────────────┐
                    │   Phone or     │
                    │  Olares One    │
                    └───┬────────┬───┘
                        │        │
              ┌─────────┴──┐  ┌──┴──────────┐
              │  Bluetooth │  │  3.5mm out  │
              │   (BLE)    │  │  (stereo)   │
              └──┬──────┬──┘  └──────┬──────┘
                 │      │            │
                 ▼      ▼            ▼
              ┌────┐ ┌─────┐  ┌────────────┐
              │H10 │ │Muse │  │  Powered   │
              │    │ │Athena│  │  splitter  │
              │BLE │ │ BLE │  │  (per-out  │
              │data│ │data │  │   volume)  │
              └────┘ └─────┘  └─┬────────┬─┘
                                │        │
                                ▼        ▼
                         ┌──────────┐ ┌──────────┐
                         │Headphones│ │  Woojer  │
                         │ (stereo) │ │ Strap 3  │
                         │ binaural │ │  3.5mm   │
                         │   beat   │ │   wired  │
                         └──────────┘ └──────────┘
```

**Why wired 3.5mm instead of Bluetooth audio for the Woojer:**

1. **Zero latency.** Wired analog audio leaves the host's DAC and arrives at the transducer at the speed of electricity. Bluetooth audio (A2DP) introduces variable latency from 40 ms to 200+ ms depending on codec and device. For the **heartbeat end-signature**, where the *LUB-dub* timing carries the meaning of the closing, Bluetooth latency could mush the rhythm or make it feel wrong. Wired guarantees the heartbeat lands in the chest exactly when the system fires it.

2. **No codec compression.** Bluetooth audio compresses the signal through SBC, AAC, or aptX codecs depending on the device pair. None of these codecs are designed for sub-audio frequencies (the GUT-regime range), and they may introduce artifacts or roll off the lowest frequencies entirely. Wired analog passes the full 1 Hz – 800 Hz Woojer range cleanly.

3. **No pairing conflicts.** The host's Bluetooth stack is dedicated to the two BLE sensors. Adding a third BT audio device would create another connection slot to manage, another potential point of failure during a session, and could compete for radio bandwidth with the sensor data streams.

4. **Reliability.** Wired connections don't drop. The Woojer can't unpair itself mid-session. The audio path is as reliable as the cable.

**Stereo channel routing — the binaural-haptic separation trick:**

Because the splitter is passive, both outputs receive the *same* stereo signal. Independent volume control happens at the splitter knobs, not in software. This works elegantly because:

- **Left channel** carries the left binaural carrier (e.g., 200 Hz)
- **Right channel** carries the right binaural carrier (e.g., 200 Hz + target frequency)
- **Headphones** receive both channels and the brain reconstructs the binaural beat at the target frequency
- **Woojer** receives both channels, sums them as a single transducer signal, and delivers the resulting tactile sensation — which contains the same target frequency information through the beat envelope

The math works out for free. The Web Audio API generates the two binaural carriers as independent oscillators on left/right channels, and the rest happens through physics.

**For octave-shifted haptic frequencies** (when the audio target exceeds the Woojer's 800 Hz upper range), the system has two implementation options:
- **Option A (v1):** Generate a separate sub-octave sine wave on the same stereo channels, mixed into the binaural carriers at low amplitude. The headphones hear it as a subtle bass undertone, the Woojer feels it as the dominant tactile signal.
- **Option B (v2 if needed):** Upgrade the host audio path to a USB DAC with multiple stereo outputs, allowing fully independent signal generation for headphones vs. Woojer.

Option A is sufficient for v1 and adds zero hardware. Defer Option B until real session data shows it's needed.

**Per-output volume balance:**
The splitter's independent volume controls let the user dial in headphones and Woojer separately. The optimal intensity for each is almost always different — headphones at comfortable listening level, Woojer at "felt clearly but not overwhelming." The one-time calibration step in §1.4 is performed *with the splitter knobs in their final positions*, so the software amplitude limits account for the actual delivered signal.

---

## 2. Sync Layer — Lab Streaming Layer (LSL)

All sensor and event streams flow through **LSL** (Lab Streaming Layer). This is non-negotiable: LSL provides sub-millisecond synchronization across heterogeneous devices and is the de facto standard in biosignal research.

### 2.1 LSL Inlets (incoming streams)

| Stream Name        | Source         | Type   | Channels | Rate     |
|--------------------|----------------|--------|----------|----------|
| `Aetheria_ECG`     | Polar H10      | float  | 1        | 130 Hz   |
| `Aetheria_RR`      | Polar H10      | float  | 1        | irregular|
| `Aetheria_EEG`     | Muse S Athena  | float  | 4        | 256 Hz   |
| `Aetheria_fNIRS`   | Muse S Athena  | float  | 4–8      | 10 Hz    |
| `Aetheria_PPG`     | Muse S Athena  | float  | 1        | 64 Hz    |
| `Aetheria_IMU`     | Muse S Athena  | float  | 6        | 52 Hz    |
| `Aetheria_Audio`   | Player         | string | 1        | event    |
| `Aetheria_Haptic`  | Haptic engine  | string | 1        | event    |

### 2.2 LSL Outlets (outgoing streams from the system)

| Stream Name             | Type   | Channels | Rate    |
|-------------------------|--------|----------|---------|
| `Aetheria_Features`     | float  | ~20      | 1 Hz    |
| `Aetheria_Coherence`    | float  | 4        | 1 Hz    |
| `Aetheria_State`        | string | 1        | event   |
| `Aetheria_Prescription` | string | 1        | event   |

### 2.3 Bridge implementations
- **Polar H10 → LSL:** use existing open-source bridges (e.g. `polar-h10-lsl`, or write a thin Python wrapper around `bleak` + `pylsl`)
- **Muse S Athena → LSL:** use `muse-lsl` (Alexandre Barachant's library) or the official Muse SDK with an LSL outlet wrapper
- **Audio → LSL:** modify the Aetheria player to publish a `pylsl` string outlet on track change and every 1 s of playback

---

## 3. Pipeline Stages

```
┌─────────────┐    ┌──────────┐    ┌──────────────┐    ┌───────────┐    ┌────────┐    ┌───────┐
│  Sensors    │───▶│   LSL    │───▶│   Buffer     │───▶│  Feature  │───▶│Coher-  │───▶│Policy │
│ H10 + Muse  │    │  Inlets  │    │ (ring, 60s)  │    │Extraction │    │ence    │    │Engine │
└─────────────┘    └──────────┘    └──────────────┘    └───────────┘    │Scoring │    └───┬───┘
                                                                        └────────┘        │
                                                                                          ▼
                                                                                   ┌────────────┐
                                                                                   │   Audio    │
                                                                                   │  Control   │
                                                                                   └────────────┘
```

### 3.1 Buffer (ring buffers per stream)
- 60-second rolling window for each inlet
- Lock-free single-producer/single-consumer where possible
- Aligned to LSL timestamps, NOT wall-clock time

### 3.2 Feature Extraction (runs at 1 Hz)
Reads the latest window from each buffer, computes the feature set defined in **Doc 2: Coherence Scoring Math**, publishes to `Aetheria_Features`.

### 3.3 Coherence Scoring (runs at 1 Hz)
Consumes features, computes the Triune Coherence Score (TCS) and per-regime coherence values, publishes to `Aetheria_Coherence`.

### 3.4 Policy Engine (runs at 1 Hz, decisions at slower cadence)
The state machine defined in **Doc 3**. Reads coherence stream, emits prescription events to `Aetheria_Prescription`, controls audio player.

### 3.5 Audio Control
Subscribes to `Aetheria_Prescription` events, transitions tracks, crossfades between frequencies, reports back via `Aetheria_Audio`.

---

## 4. Storage — Session Recordings

Every session writes a single **HDF5** file (or XDF, the LSL-native format — XDF is preferable for round-tripping back into LSL tools).

### 4.1 Required contents
- All raw LSL streams (ECG, EEG, fNIRS, PPG, IMU, RR)
- All derived streams (features, coherence, state, prescription, audio events)
- Session metadata: user ID, session ID, start/end timestamps, software version, sensor firmware versions, electrode quality scores at start
- User-reported felt-sense data (pre/post questionnaire as JSON sidecar)

### 4.2 File naming
```
sessions/{user_id}/{YYYY-MM-DD}_{session_id}.xdf
sessions/{user_id}/{YYYY-MM-DD}_{session_id}.meta.json
```

### 4.3 Why XDF
XDF preserves LSL's nanosecond timestamps and stream metadata losslessly. It can be replayed through LSL exactly as if the session were live, which means the policy engine can be re-run on historical data after rule changes — critical for refining the prescription engine without needing fresh sessions.

---

## 5. Hardware Quality Gates

Before any session begins, the system must verify:

1. **H10 contact quality** — RR variability sane (no flatlines, no impossible jumps), signal RMS within expected range
2. **Muse contact quality** — Muse SDK reports contact ≥ "good" on all 4 EEG channels
3. **fNIRS baseline** — HbO/HbR signal variance within sensor noise floor
4. **LSL sync verification** — measure clock offset across streams, must be < 10 ms
5. **Audio routing** — confirm playback device, volume calibration tone

If any gate fails: refuse to enter BASELINE state, surface specific failure to user with remediation hint.

---

## 6. Software Stack (recommended)

| Layer              | Library                          | Notes |
|--------------------|----------------------------------|-------|
| BLE                | `bleak` (Python)                 | Cross-platform |
| LSL                | `pylsl`                          | Bindings to liblsl |
| Signal processing  | `neurokit2`, `scipy`, `mne`      | NK2 for HRV, MNE for EEG |
| Numerical          | `numpy`, `numba` for hot loops   | |
| Storage            | `pyxdf` (read), `pylsl` (write)  | |
| State machine      | `transitions` (Python)           | Lightweight FSM |
| Audio              | existing Aetheria player + `pylsl` outlet hook | |
| Visualization      | `pyqtgraph` for live, `plotly` for review | |

Everything in Python keeps Axel's surface area small and matches the rest of the Aetheria codebase.

---

## 7. Deployment Target

- **Primary:** Olares One personal AI server (runs the pipeline + storage + Axel)
- **Edge:** ASUS ROG Phone 9 Pro can run a stripped-down version for portable sessions, syncing recordings back to Olares on reconnect
- **Sensors connect to:** whichever device is running the pipeline, via BLE

---

## 8. Open Questions for Joseph

1. Do you want **multi-user** session support (Joseph + Alisha synchronized session) in v1, or is that v2?

---

## Next Documents
- **Doc 2:** Coherence Scoring Math — feature definitions, regime scoring, Triune Coherence Score
- **Doc 3:** Adaptive Prescription State Machine — baseline → assess → entrain → evaluate → transition logic
