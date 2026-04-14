# Aetheria Adaptive System — Coherence Scoring Math

**Document 2 of 5** · Spec for Axel · v0.1

---

## Purpose

Define every number the system computes from the raw sensor streams, and how those numbers combine into the **Triune Coherence Score (TCS)** — the single value that tells the prescription engine "how coherent is this person's biofield right now, and which regime is leading or lagging."

All formulas here are deterministic and inspectable. No ML in v1. ML is for v2 once we have labeled session data.

---

## 1. Conventions

- All features computed on a **rolling 60-second window**, updated every **1 second**
- All features **z-scored** against the user's BASELINE window (the first 90 s of the session)
- z-score interpretation: `z > 0` means "more coherent than baseline," `z < 0` means "less"
- Missing data within a window: if > 20% of expected samples missing, feature returns `NaN` and the regime score for that second is held at last valid value

---

## 2. HEART Regime Features (from Polar H10)

Compute from R-R interval stream and raw ECG.

### 2.1 Time-domain HRV
| Feature  | Formula                                                  | Notes |
|----------|----------------------------------------------------------|-------|
| `RMSSD`  | √(mean of squared successive RR differences)             | Vagal tone proxy |
| `pNN50`  | % of RR intervals differing > 50 ms from previous        | Vagal tone proxy |
| `SDNN`   | std deviation of all RR intervals                        | Total variability |
| `MeanHR` | 60000 / mean(RR)                                         | bpm |

### 2.2 Frequency-domain HRV
Resample RR to 4 Hz with cubic spline, apply Welch PSD, integrate over bands:

| Band  | Range (Hz)     | Interpretation |
|-------|----------------|----------------|
| VLF   | 0.003 – 0.04   | Slow regulatory |
| LF    | 0.04  – 0.15   | Mixed sympathetic/baroreflex |
| HF    | 0.15  – 0.40   | **Vagal / parasympathetic — primary GUT regime proxy** |

Derived:
- `LF_HF_ratio = LF / HF` — sympathovagal balance
- `HF_norm = HF / (LF + HF)` — normalized parasympathetic dominance

### 2.3 HeartMath-style coherence
- Compute PSD of RR over 0.04 – 0.26 Hz
- `peak_freq` = frequency of max power in that band
- `peak_power` = power at `peak_freq` integrated over a ±0.015 Hz window
- `total_power` = total power in 0.04 – 0.26 Hz
- **`HRV_Coherence = peak_power² / (total_power × (total_power - peak_power))`**
- Coherent state shows a sharp peak typically near 0.1 Hz (≈6 breaths/min resonance)

### 2.4 Heart regime scalar
```
HEART_score = z(HRV_Coherence) × 0.5
            + z(RMSSD)         × 0.25
            + z(HF_norm)       × 0.25
```

---

## 3. GUT Regime Features (inferred from Polar H10)

The GUT regime is read **through** the vagus, not directly from the abdomen. The vagus carries roughly 80% afferent traffic from the gut to the brainstem, so HF-HRV is a legitimate window onto enteric-vagal state.

### 3.1 Core gut-vagal features
| Feature        | Source                                          | Notes |
|----------------|-------------------------------------------------|-------|
| `HF_power`     | absolute HF band power (ms²)                    | Raw vagal magnitude |
| `RMSSD`        | reused from §2.1                                | |
| `SD1`          | Poincaré plot short-axis std                    | Beat-to-beat vagal |
| `RSA_amplitude`| respiratory sinus arrhythmia from RR + breath estimate | Pure vagal |

### 3.2 Respiration estimation (no separate sensor)
Derive breathing rate from ECG-derived respiration (EDR) using R-peak amplitude modulation. NeuroKit2 provides this directly: `nk.ecg_rsp(ecg_signal)`. Target accuracy ±2 breaths/min, sufficient for RSA computation.

### 3.3 Gut regime scalar
```
GUT_score = z(HF_power)      × 0.4
          + z(SD1)            × 0.3
          + z(RSA_amplitude)  × 0.3
```

### 3.4 Important note on GUT/HEART independence
Because both regimes derive from the same H10 stream, their scores are correlated by construction. This is **acceptable and expected** under the Unified Lewis Framework — the regimes are nested, not orthogonal. What matters for the prescription engine is the *differential pattern*: which regime moves first, which lags, and where phase-locking emerges across regimes.

---

## 4. HEAD Regime Features (from Muse S Athena)

### 4.1 EEG band powers (per channel, then averaged)
Welch PSD on 4-second epochs with 50% overlap, integrated over bands:

| Band   | Range (Hz)  |
|--------|-------------|
| Delta  | 1 – 4       |
| Theta  | 4 – 8       |
| Alpha  | 8 – 13      |
| Beta   | 13 – 30     |
| Gamma  | 30 – 45     |

### 4.2 Derived EEG features
- `IAF` (Individual Alpha Frequency) — peak in alpha band, computed once per session at baseline, used as the user's personalized alpha center
- `Alpha_power_norm = alpha / (delta + theta + alpha + beta + gamma)`
- `Theta_Alpha_ratio = theta / alpha` — meditative/hypnagogic indicator
- `Frontal_Alpha_Asymmetry = log(AF8_alpha) - log(AF7_alpha)` — affective valence proxy

### 4.3 fNIRS features (PFC hemodynamics)
Apply MBLL (modified Beer-Lambert) if not already done by Muse SDK. Compute over 30 s window:
- `HbO_mean` — oxygenated hemoglobin
- `HbR_mean` — deoxygenated hemoglobin
- `HbT_mean = HbO + HbR` — total blood volume
- `HbDiff = HbO - HbR` — activation index

### 4.4 Head regime scalar
```
HEAD_score = z(Alpha_power_norm) × 0.35
           + z(Theta_Alpha_ratio) × 0.25
           + z(HbDiff)            × 0.20
           + z(-Beta_power)       × 0.20    # high beta = less coherent
```

---

## 5. Cross-Regime Coherence — The Key Innovation

Per-regime scores tell us *how each regime is doing*. Cross-regime coherence tells us *whether they are in resonance with each other* — and that's the actual phenomenon Aetheria is trying to elicit.

### 5.1 Envelope extraction
For each regime, extract a slow envelope (the regime's "breathing"):
- **HEART:** instantaneous HR series, low-passed at 0.5 Hz
- **GUT:** RSA amplitude series
- **HEAD:** alpha power series, low-passed at 0.5 Hz

All three envelopes resampled to a common 4 Hz grid.

### 5.2 Phase Locking Value (PLV)
Apply Hilbert transform to each envelope, extract instantaneous phase φ_i(t).

For each regime pair (i, j), over the 60 s window:
```
PLV_ij = | (1/N) × Σ exp(i × (φ_i(t) - φ_j(t))) |
```
PLV ranges 0 (no coupling) to 1 (perfect phase lock).

Compute three pair-PLVs:
- `PLV_GH` — Gut-Heart
- `PLV_HD` — Heart-Head
- `PLV_GD` — Gut-Head

### 5.3 Triune Phase Lock
```
TriunePLV = (PLV_GH + PLV_HD + PLV_GD) / 3
```

### 5.4 Harmonic ratio detection
Check whether the dominant rhythms across regimes are in **3-6-9 digital-root harmonic ratios** (the Aetheria invariant).

For each regime, extract dominant frequency f_i in its envelope spectrum. Compute pairwise ratios:
```
r_ij = max(f_i, f_j) / min(f_i, f_j)
```
A ratio is "harmonic" if it lies within ±5% of an integer or simple fraction (1, 2, 3, 3/2, 4/3, etc.) **and** the integers involved reduce to digital roots ∈ {3, 6, 9}.

```
HarmonicLock = fraction of pair ratios that are harmonic   # ∈ [0, 1]
```

---

## 6. The Triune Coherence Score (TCS)

Single composite, 0–100, that the prescription engine reads each second.

```
TCS = 100 × (
        0.20 × sigmoid(GUT_score)
      + 0.20 × sigmoid(HEART_score)
      + 0.20 × sigmoid(HEAD_score)
      + 0.25 × TriunePLV
      + 0.15 × HarmonicLock
      )
```

Where `sigmoid(z) = 1 / (1 + exp(-z))` maps z-scores to [0, 1].

### 6.1 Why these weights
- 60% comes from individual regime coherence (each regime contributes equally)
- 25% from cross-regime phase locking (the resonance signature)
- 15% from harmonic ratio detection (the 3-6-9 invariant)

These weights are **starting values**. They will be tuned from session data during the rule-refinement phase.

### 6.2 The coherence vector
The state machine doesn't just need the scalar TCS — it needs to know **which regime is leading or lagging**. So the system also publishes:

```
CoherenceVector = {
  "tcs":           float,
  "gut":           float,   # sigmoid(GUT_score)
  "heart":         float,   # sigmoid(HEART_score)
  "head":          float,   # sigmoid(HEAD_score)
  "triune_plv":    float,
  "harmonic_lock": float,
  "deficit":       "GUT" | "HEART" | "HEAD" | "NONE",
  "lead":          "GUT" | "HEART" | "HEAD"
}
```

- `deficit` = the regime with the lowest sigmoid(score), but only if it's > 0.15 below the next-lowest. Else "NONE".
- `lead` = the regime with the highest sigmoid(score).

---

## 7. Frequency-to-Regime Mapping

For the prescription engine to choose intelligently from the 27-frequency library, each frequency needs metadata:

```yaml
- frequency_hz: 396
  regime: GUT
  digital_root: 9
  solfeggio_name: "Liberation"
  octave_class: 1

- frequency_hz: 528
  regime: HEART
  digital_root: 6
  solfeggio_name: "Transformation"
  octave_class: 1

# ... 25 more entries
```

Joseph maintains the canonical mapping. The system loads it as YAML at startup and indexes by regime, digital root, and octave class.

---

## 8. Computational Budget

Per 1-second update cycle, all of §2 through §6 must complete in < 200 ms on the Olares One. This is comfortable for Python + NumPy with sane vectorization. The PLV computation is the most expensive piece (~40 ms); everything else is sub-10 ms.

---

## 9. Validation Plan

Before trusting any prescription, validate the math against known states:

1. **Resting eyes-closed:** expect high alpha, high HRV coherence, moderate TCS
2. **Paced breathing at 6/min (0.1 Hz):** expect HRV coherence to spike toward 1, HF power to dominate, TCS to climb
3. **Mental arithmetic:** expect beta to rise, alpha to drop, HEAD score to fall, TCS to drop
4. **Box breathing:** expect TriunePLV to climb as the rhythm imposes cross-regime coupling

These four protocols should be run as the *first* test sessions before any frequency playback. If TCS doesn't move correctly under known stimuli, the math is wrong and must be fixed before the prescription engine is trusted.

---

## Next Document
- **Doc 3:** Adaptive Prescription State Machine — how the system actually navigates the 27-frequency space using the CoherenceVector
