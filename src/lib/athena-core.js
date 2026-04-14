/**
 * AthenaDevice — Browser-native Muse S Athena BLE library
 *
 * Full-capability JavaScript driver for the Muse S Athena headband.
 * Supports EEG (4/8ch), PPG, fNIRS (HbO/HbR), Accelerometer, Gyroscope, Battery.
 *
 * Usage:
 *   <script src="athena-core.js"></script>
 *   <script>
 *     const muse = new AthenaDevice({
 *       preset: 'p1041',
 *       onEEG:        (data) => { },
 *       onPPG:        (data) => { },
 *       onFNIRS:      (data) => { },
 *       onAccGyro:    (data) => { },
 *       onBattery:    (pct)  => { },
 *       onBandPowers: (bp)   => { },
 *       onStatus:     (s)    => { },
 *       onLog:        (type, msg) => { },
 *     });
 *     await muse.connect();
 *     await muse.startStream();
 *   </script>
 *
 * Ported from OpenMuse (Python) by the Aetheria project.
 * Protocol reference: ATHENA_PORT_SPEC.md
 *
 * @version 2.0.0
 * @license MIT
 */
(function (root) {
  'use strict';

  // =================================================================
  // CONSTANTS
  // =================================================================

  const MUSE_SERVICE    = 0xfe8d;
  const CONTROL_UUID    = '273e0001-4c4d-454d-96be-f03bac821358';
  const EEG_DATA_UUID   = '273e0013-4c4d-454d-96be-f03bac821358';
  const OTHER_DATA_UUID = '273e0014-4c4d-454d-96be-f03bac821358';

  const EEG_SCALE     = 1450.0 / 16383.0;
  const OPTICS_SCALE  = 1.0 / 32768.0;
  const ACC_SCALE     = 0.0000610352;
  const GYRO_SCALE    = -0.0074768;
  const DC_OFFSET_RAW = 8192;

  const TAG_CONFIG = {
    0x11: { name: 'EEG4',       type: 'EEG',     ch: 4,  spp: 4, rate: 256, bytes: 28  },
    0x12: { name: 'EEG8',       type: 'EEG',     ch: 8,  spp: 2, rate: 256, bytes: 28  },
    0x34: { name: 'OPTICS4',    type: 'OPTICS',  ch: 4,  spp: 3, rate: 64,  bytes: 30  },
    0x35: { name: 'OPTICS8',    type: 'OPTICS',  ch: 8,  spp: 2, rate: 64,  bytes: 40  },
    0x36: { name: 'OPTICS16',   type: 'OPTICS',  ch: 16, spp: 1, rate: 64,  bytes: 40  },
    0x47: { name: 'ACCGYRO',    type: 'ACCGYRO', ch: 6,  spp: 3, rate: 52,  bytes: 36  },
    0x53: { name: 'UNKNOWN_53', type: 'Unknown', ch: 0,  spp: 0, rate: 0,   bytes: 24  },
    0x88: { name: 'BATTERY',    type: 'BATTERY', ch: 1,  spp: 1, rate: 0.2, bytes: -1  },
    0x98: { name: 'BATTERY_OLD',type: 'BATTERY', ch: 1,  spp: 1, rate: 1,   bytes: 20  },
  };

  const EEG_LABELS_8 = ['TP9','AF7','AF8','TP10','AUX1','AUX2','AUX3','AUX4'];
  const EEG_LABELS_4 = ['TP9','AF7','AF8','TP10'];

  const ACCGYRO_LABELS = ['ACC_X','ACC_Y','ACC_Z','GYRO_X','GYRO_Y','GYRO_Z'];

  const OPTICS_CH_MAP = {
    4:  ['LI_NIR','RI_NIR','LI_IR','RI_IR'],
    8:  ['LO_NIR','RO_NIR','LO_IR','RO_IR','LI_NIR','RI_NIR','LI_IR','RI_IR'],
    16: ['LO_NIR','RO_NIR','LO_IR','RO_IR','LI_NIR','RI_NIR','LI_IR','RI_IR',
         'LO_RED','RO_RED','LO_AMB','RO_AMB','LI_RED','RI_RED','LI_AMB','RI_AMB'],
  };

  const FNIRS_EPS = {
    '660': { HbO: 319.6,  HbR: 3226.56 },
    '730': { HbO: 390.0,  HbR: 1102.2  },
    '850': { HbO: 1058.0, HbR: 691.32  },
  };

  const FNIRS_POSITIONS = {
    LO: { '660':'LO_RED', '730':'LO_NIR', '850':'LO_IR', amb:'LO_AMB' },
    RO: { '660':'RO_RED', '730':'RO_NIR', '850':'RO_IR', amb:'RO_AMB' },
    LI: { '660':'LI_RED', '730':'LI_NIR', '850':'LI_IR', amb:'LI_AMB' },
    RI: { '660':'RI_RED', '730':'RI_NIR', '850':'RI_IR', amb:'RI_AMB' },
  };

  /** Available presets with descriptions. */
  const PRESETS = {
    p21:   { eeg: 4,  optics: 0,  desc: 'EEG4 only' },
    p1045: { eeg: 8,  optics: 4,  desc: 'EEG8 + Optics4' },
    p1043: { eeg: 8,  optics: 8,  desc: 'EEG8 + Optics8' },
    p1034: { eeg: 8,  optics: 8,  desc: 'EEG8 + Optics8' },
    p1041: { eeg: 8,  optics: 16, desc: 'EEG8 + Optics16 (full, recommended)' },
  };


  // =================================================================
  // DECODERS
  // =================================================================

  function decodeBitPacked(bytes, bitsPerValue, numValues) {
    const out = new Uint32Array(numValues);
    for (let i = 0; i < numValues; i++) {
      let val = 0;
      const base = i * bitsPerValue;
      for (let b = 0; b < bitsPerValue; b++) {
        const pos = base + b;
        if ((bytes[pos >> 3] >> (pos & 7)) & 1) val |= (1 << b);
      }
      out[i] = val;
    }
    return out;
  }

  function decodeEEG(data, numCh, subtractDC) {
    const spp = numCh === 4 ? 4 : 2;
    const raw = decodeBitPacked(data, 14, numCh * spp);
    const samples = [];
    for (let s = 0; s < spp; s++) {
      const row = new Float64Array(numCh);
      for (let c = 0; c < numCh; c++) {
        let r = raw[s * numCh + c];
        if (subtractDC) r -= DC_OFFSET_RAW;
        row[c] = r * EEG_SCALE;
      }
      samples.push(row);
    }
    return samples;
  }

  function decodeOptics(data, numCh) {
    const spp = numCh === 4 ? 3 : numCh === 8 ? 2 : 1;
    const raw = decodeBitPacked(data, 20, numCh * spp);
    const samples = [];
    for (let s = 0; s < spp; s++) {
      const row = new Float64Array(numCh);
      for (let c = 0; c < numCh; c++) {
        row[c] = raw[s * numCh + c] * OPTICS_SCALE;
      }
      samples.push(row);
    }
    return samples;
  }

  function decodeAccGyro(data) {
    const samples = [];
    for (let s = 0; s < 3; s++) {
      const row = new Float64Array(6);
      for (let c = 0; c < 6; c++) {
        const off = (s * 6 + c) * 2;
        let v = data[off] | (data[off + 1] << 8);
        if (v >= 0x8000) v -= 0x10000;
        row[c] = c < 3 ? v * ACC_SCALE : v * GYRO_SCALE;
      }
      samples.push(row);
    }
    return samples;
  }

  function decodeBattery(data) {
    if (data.length < 2) return null;
    return (data[0] | (data[1] << 8)) / 256.0;
  }


  // =================================================================
  // PACKET PARSER
  // =================================================================

  function parseNotification(buffer, hostTime) {
    const data = new Uint8Array(buffer);
    const packets = [];
    let off = 0;
    while (off < data.length) {
      const pktLen = data[off];
      if (pktLen < 14 || off + pktLen > data.length) break;
      packets.push(parsePacket(data.subarray(off, off + pktLen), hostTime));
      off += pktLen;
    }
    return packets;
  }

  function parsePacket(bytes, hostTime) {
    const hdr = {
      len: bytes[0], seq: bytes[1],
      devTime: (bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)) >>> 0,
      pktId: bytes[9], byte13: bytes[13], hostTime: hostTime,
    };
    const subs = [];
    let off = 14;

    const cfg0 = TAG_CONFIG[hdr.pktId];
    if (cfg0) {
      const dLen = cfg0.bytes === -1 ? bytes.length - off : cfg0.bytes;
      if (off + dLen <= bytes.length) {
        subs.push({ tag: hdr.pktId, name: cfg0.name, type: cfg0.type, idx: hdr.seq, data: bytes.slice(off, off + dLen) });
        off += dLen;
      }
    }

    while (off + 5 < bytes.length) {
      const tag = bytes[off];
      const idx = bytes[off + 1];
      off += 5;
      const cfg = TAG_CONFIG[tag];
      if (cfg) {
        const dLen = cfg.bytes === -1 ? bytes.length - off : cfg.bytes;
        if (off + dLen <= bytes.length) {
          subs.push({ tag, name: cfg.name, type: cfg.type, idx, data: bytes.slice(off, off + dLen) });
          off += dLen;
        } else break;
      } else {
        subs.push({ tag, name: 'UNK_0x' + tag.toString(16), type: 'Unknown', idx, data: bytes.slice(off) });
        break;
      }
    }

    return { hdr, subs, raw: bytes };
  }


  // =================================================================
  // DSP: BIQUAD FILTER
  // =================================================================

  function biquadLPF(fc, fs) {
    const w0 = 2 * Math.PI * fc / fs;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cosw = Math.cos(w0);
    const a0 = 1 + alpha;
    return { b: [(1 - cosw) / 2 / a0, (1 - cosw) / a0, (1 - cosw) / 2 / a0], a: [1, -2 * cosw / a0, (1 - alpha) / a0] };
  }

  function biquadHPF(fc, fs) {
    const w0 = 2 * Math.PI * fc / fs;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cosw = Math.cos(w0);
    const a0 = 1 + alpha;
    return { b: [(1 + cosw) / 2 / a0, -(1 + cosw) / a0, (1 + cosw) / 2 / a0], a: [1, -2 * cosw / a0, (1 - alpha) / a0] };
  }

  function filterForward(b, a, data) {
    const n = data.length;
    const out = new Float64Array(n);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      out[i] = b[0] * data[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = data[i];
      y2 = y1; y1 = out[i];
    }
    return out;
  }

  function filtfilt(b, a, data) {
    const fwd = filterForward(b, a, data);
    const n = fwd.length;
    const rev = new Float64Array(n);
    for (let i = 0; i < n; i++) rev[i] = fwd[n - 1 - i];
    const bwd = filterForward(b, a, rev);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = bwd[n - 1 - i];
    return out;
  }

  function bandpassFiltfilt(fLow, fHigh, fs, data) {
    const hp = biquadHPF(fLow, fs);
    const lp = biquadLPF(fHigh, fs);
    return filtfilt(lp.b, lp.a, filtfilt(hp.b, hp.a, data));
  }


  // =================================================================
  // DSP: FFT
  // =================================================================

  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wR = Math.cos(ang), wI = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cR = 1, cI = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const k = i + j + half;
          const tR = re[k] * cR - im[k] * cI;
          const tI = re[k] * cI + im[k] * cR;
          re[k] = re[i + j] - tR;
          im[k] = im[i + j] - tI;
          re[i + j] += tR;
          im[i + j] += tI;
          const nR = cR * wR - cI * wI;
          cI = cR * wI + cI * wR;
          cR = nR;
        }
      }
    }
  }

  function computePowerSpectrum(data, fs) {
    const N = nextPow2(data.length);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const n = data.length;
    for (let i = 0; i < n; i++) {
      re[i] = data[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    }
    fftInPlace(re, im);
    const nBins = (N >> 1) + 1;
    const psd = new Float64Array(nBins);
    const freqs = new Float64Array(nBins);
    for (let i = 0; i < nBins; i++) {
      psd[i] = re[i] * re[i] + im[i] * im[i];
      freqs[i] = i * fs / N;
    }
    return { psd, freqs, N };
  }

  function computeBandPowers(data, fs) {
    if (data.length < 64) return null;
    const { psd, freqs } = computePowerSpectrum(data, fs);
    const bands = { delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
    const result = {};
    let total = 0;
    for (const [name, [lo, hi]] of Object.entries(bands)) {
      let power = 0;
      for (let i = 0; i < freqs.length; i++) {
        if (freqs[i] >= lo && freqs[i] < hi) power += psd[i];
      }
      result[name] = power;
      total += power;
    }
    if (total > 0) for (const k of Object.keys(result)) result[k] /= total;
    return result;
  }

  function computePPGSQI(filtered, fs) {
    const n = filtered.length;
    if (n < 64) return 0;
    const { psd, freqs } = computePowerSpectrum(filtered, fs);
    let pulsePower = 0, totalPower = 0;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (f >= 0.5 && f <= 8.0) totalPower += psd[i];
      if (f >= 0.6 && f <= 4.0) pulsePower += psd[i];
    }
    return totalPower > 1e-10 ? Math.min(1, pulsePower / totalPower) : 0;
  }


  // =================================================================
  // DSP: LEAST SQUARES (mBLL)
  // =================================================================

  function lstsq2(A, bVecs) {
    const nWl = A.length;
    const nTime = bVecs[0].length;
    let a00 = 0, a01 = 0, a11 = 0;
    for (let i = 0; i < nWl; i++) {
      a00 += A[i][0] * A[i][0];
      a01 += A[i][0] * A[i][1];
      a11 += A[i][1] * A[i][1];
    }
    const det = a00 * a11 - a01 * a01;
    if (Math.abs(det) < 1e-30) return [new Float64Array(nTime), new Float64Array(nTime)];
    const inv00 = a11 / det, inv01 = -a01 / det, inv11 = a00 / det;
    const M0 = new Float64Array(nWl);
    const M1 = new Float64Array(nWl);
    for (let j = 0; j < nWl; j++) {
      M0[j] = inv00 * A[j][0] + inv01 * A[j][1];
      M1[j] = inv01 * A[j][0] + inv11 * A[j][1];
    }
    const hbo = new Float64Array(nTime);
    const hbr = new Float64Array(nTime);
    for (let t = 0; t < nTime; t++) {
      let s0 = 0, s1 = 0;
      for (let j = 0; j < nWl; j++) { s0 += M0[j] * bVecs[j][t]; s1 += M1[j] * bVecs[j][t]; }
      hbo[t] = s0; hbr[t] = s1;
    }
    return [hbo, hbr];
  }

  function computeAntiCorrelation(a, b) {
    const n = a.length;
    if (n < 4) return 0;
    let sumA = 0, sumB = 0;
    for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
    const meanA = sumA / n, meanB = sumB / n;
    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA, db = b[i] - meanB;
      cov += da * db; varA += da * da; varB += db * db;
    }
    const denom = Math.sqrt(varA * varB);
    return denom < 1e-20 ? 0 : -(cov / denom);
  }


  // =================================================================
  // PROCESSING: PPG PIPELINE
  // =================================================================

  function getOpticsChannel(name, samplesBuf, numCh) {
    const map = OPTICS_CH_MAP[numCh];
    if (!map) return null;
    const idx = map.indexOf(name);
    if (idx === -1) return null;
    const n = samplesBuf.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = samplesBuf[i][idx];
    return out;
  }

  function processPPGBatch(samplesBuf, numCh) {
    const n = samplesBuf.length;
    if (n < 256) return null;
    const fs = 64;
    const getCh = (name) => getOpticsChannel(name, samplesBuf, numCh);
    const ambSub = (sig, amb) => {
      if (!sig) return null;
      if (!amb) return sig;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = sig[i] - amb[i];
      return out;
    };

    const ppgKeys = ['LI_NIR', 'RI_NIR', 'LI_IR', 'RI_IR', 'LO_NIR', 'RO_NIR', 'LO_IR', 'RO_IR'];
    const ambMap = { LI: 'LI_AMB', RI: 'RI_AMB', LO: 'LO_AMB', RO: 'RO_AMB' };
    const cleaned = {};
    for (const key of ppgKeys) {
      cleaned[key] = ambSub(getCh(key), getCh(ambMap[key.substring(0, 2)]));
    }

    let bvp = new Float64Array(n);
    let totalWeight = 0;
    const weights = {};
    for (const key of ppgKeys) {
      const sig = cleaned[key];
      if (!sig) continue;
      let filtered;
      try { filtered = bandpassFiltfilt(0.5, 8.0, fs, sig); } catch (_) { continue; }
      const sqi = computePPGSQI(filtered, fs);
      const w = sqi * sqi;
      weights[key] = { sqi: +sqi.toFixed(3), weight: +w.toFixed(4) };
      for (let i = 0; i < n; i++) bvp[i] += filtered[i] * w;
      totalWeight += w;
    }

    if (totalWeight > 1e-10) {
      for (let i = 0; i < n; i++) bvp[i] = -bvp[i] / totalWeight;
    }

    const heartRate = estimateHeartRate(bvp, fs);
    const sqiValues = Object.values(weights).map(w => w.sqi);
    const meanSQI = sqiValues.length > 0 ? sqiValues.reduce((a, b) => a + b, 0) / sqiValues.length : 0;

    return { bvp: Array.from(bvp), sqi: +meanSQI.toFixed(3), heartRate, weights, nChannels: Object.keys(weights).length };
  }

  function estimateHeartRate(bvp, fs) {
    const n = bvp.length;
    if (n < fs * 3) return 0;
    const start = Math.max(0, n - 8 * fs);
    const seg = bvp.slice(start);
    const peaks = [];
    const minDist = Math.floor(fs * 0.4);
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    for (let i = 2; i < seg.length - 2; i++) {
      if (seg[i] > seg[i - 1] && seg[i] > seg[i - 2] && seg[i] >= seg[i + 1] && seg[i] >= seg[i + 2] && seg[i] > mean) {
        if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDist) peaks.push(i);
      }
    }
    if (peaks.length < 3) return 0;
    let totalInt = 0;
    for (let i = 1; i < peaks.length; i++) totalInt += peaks[i] - peaks[i - 1];
    const hr = Math.round(60 * fs / (totalInt / (peaks.length - 1)));
    return (hr >= 40 && hr <= 200) ? hr : 0;
  }


  // =================================================================
  // PROCESSING: fNIRS PIPELINE
  // =================================================================

  function processFNIRSBatch(samplesBuf, numCh) {
    const n = samplesBuf.length;
    if (n < 640) return null;
    const fs = 64;
    const separation = 3.0, dpf = 7.0;
    const path = separation * dpf;
    const getCh = (name) => getOpticsChannel(name, samplesBuf, numCh);
    const result = {};

    for (const [pos, chans] of Object.entries(FNIRS_POSITIONS)) {
      const amb = getCh(chans.amb);
      const wlData = {};
      for (const wl of ['660', '730', '850']) {
        const sig = getCh(chans[wl]);
        if (!sig) continue;
        const cleaned = new Float64Array(n);
        if (amb) { for (let i = 0; i < n; i++) cleaned[i] = sig[i] - amb[i]; }
        else { for (let i = 0; i < n; i++) cleaned[i] = sig[i]; }
        wlData[wl] = cleaned;
      }

      const wlList = Object.keys(wlData);
      if (wlList.length < 2) continue;

      const dodVecs = [];
      const epsMatrix = [];
      for (const wl of wlList) {
        const sig = wlData[wl];
        const i0 = sig.reduce((a, b) => a + b, 0) / n;
        const dod = new Float64Array(n);
        for (let i = 0; i < n; i++) dod[i] = -Math.log(Math.max(sig[i], 1e-10) / Math.max(i0, 1e-10));
        let filtered;
        try { filtered = bandpassFiltfilt(0.01, 0.1, fs, dod); } catch (_) { filtered = dod; }
        const scaled = new Float64Array(n);
        for (let i = 0; i < n; i++) scaled[i] = filtered[i] / path;
        dodVecs.push(scaled);
        epsMatrix.push([FNIRS_EPS[wl].HbO, FNIRS_EPS[wl].HbR]);
      }

      const [hbo, hbr] = lstsq2(epsMatrix, dodVecs);
      const hboUM = new Float64Array(n), hbrUM = new Float64Array(n), hbdiff = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        hboUM[i] = hbo[i] * 1e6; hbrUM[i] = hbr[i] * 1e6;
        hbdiff[i] = hboUM[i] - hbrUM[i];
      }

      const wSamples = Math.min(n, 10 * fs);
      const sqi = computeAntiCorrelation(hboUM.slice(n - wSamples), hbrUM.slice(n - wSamples));

      result[pos] = {
        hbo: Array.from(hboUM), hbr: Array.from(hbrUM), hbdiff: Array.from(hbdiff),
        sqi: +sqi.toFixed(3),
        lastHbO: +hboUM[n - 1].toFixed(3), lastHbR: +hbrUM[n - 1].toFixed(3),
        lastHbDiff: +hbdiff[n - 1].toFixed(3),
      };
    }

    return Object.keys(result).length > 0 ? result : null;
  }


  // =================================================================
  // PROTOCOL COMMANDS
  // =================================================================

  function encodeCommand(cmd) {
    const payload = cmd + '\n';
    const buf = new Uint8Array(1 + payload.length);
    buf[0] = buf.length;
    for (let i = 0; i < payload.length; i++) buf[i + 1] = payload.charCodeAt(i);
    return buf;
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }


  // =================================================================
  // AthenaDevice CLASS
  // =================================================================

  /**
   * Muse S Athena BLE device controller.
   *
   * @param {Object} options
   * @param {string}   [options.preset='p1041']         Streaming preset command
   * @param {boolean}  [options.dcOffset=false]          Subtract DC offset from EEG
   * @param {number}   [options.processInterval=500]     Processing interval (ms)
   * @param {number}   [options.exportSeconds=30]        Seconds of data to retain for export
   *
   * @param {Function} [options.onEEG]         (data) => {}  — called per EEG subpacket
   * @param {Function} [options.onOptics]      (data) => {}  — called per optics subpacket
   * @param {Function} [options.onAccGyro]     (data) => {}  — called per AccGyro subpacket
   * @param {Function} [options.onBattery]     (pct)  => {}  — called on battery reading
   * @param {Function} [options.onPPG]         (data) => {}  — called every processInterval
   * @param {Function} [options.onFNIRS]       (data) => {}  — called every processInterval
   * @param {Function} [options.onBandPowers]  (bp)   => {}  — called every processInterval
   * @param {Function} [options.onStatus]      (status) => {} — 'disconnected'|'connecting'|'connected'|'streaming'
   * @param {Function} [options.onLog]         (type, msg) => {} — 'info'|'error'|'tx'|'rx'
   * @param {Function} [options.onRawPacket]   (packet) => {} — raw parsed packet
   */
  class AthenaDevice {

    constructor(options = {}) {
      this._preset         = options.preset || 'p1041';
      this._dcOffset       = options.dcOffset || false;
      this._processInterval = options.processInterval || 500;
      this._exportSeconds  = options.exportSeconds || 30;

      // Callbacks
      this._onEEGCb        = options.onEEG || null;
      this._onOpticsCb     = options.onOptics || null;
      this._onAccGyroCb    = options.onAccGyro || null;
      this._onBatteryCb    = options.onBattery || null;
      this._onPPGCb        = options.onPPG || null;
      this._onFNIRSCb      = options.onFNIRS || null;
      this._onBandPowersCb = options.onBandPowers || null;
      this._onStatusCb     = options.onStatus || null;
      this._onLogCb        = options.onLog || null;
      this._onRawPacketCb  = options.onRawPacket || null;

      // BLE handles
      this._device      = null;
      this._server      = null;
      this._controlChar = null;
      this._eegChar     = null;
      this._otherChar   = null;

      // State
      this._status      = 'disconnected';
      this._firmware    = '';
      this._battery     = null;
      this._eegMode     = null;
      this._opticsMode  = null;
      this._opticsNumCh = 0;

      // Counters
      this._counts = { total: 0, eeg: 0, optics: 0, accgyro: 0, battery: 0 };

      // EEG buffers
      this._eegBuf1s = Array.from({ length: 8 }, () => []);

      // Optics buffer (for PPG/fNIRS processing)
      this._opticsBuf = [];

      // Export buffers
      this._exp = { raw: [], eeg: [], optics: [], accgyro: [] };

      // Processing results
      this._ppg        = null;
      this._fnirs      = null;
      this._bandPowers = null;
      this._processTimer = null;

      // Bind event handlers
      this._handleBLEData       = this._handleBLEData.bind(this);
      this._handleBLEControl    = this._handleBLEControl.bind(this);
      this._handleBLEDisconnect = this._handleBLEDisconnect.bind(this);
    }

    // --- Public getters ---

    get status()     { return this._status; }
    get battery()    { return this._battery; }
    get firmware()   { return this._firmware; }
    get deviceName() { return this._device ? this._device.name : null; }
    get eegMode()    { return this._eegMode; }
    get opticsMode() { return this._opticsMode; }
    get counts()     { return { ...this._counts }; }
    get preset()     { return this._preset; }
    get ppg()        { return this._ppg; }
    get fnirs()      { return this._fnirs; }
    get bandPowers() { return this._bandPowers; }

    // --- Public setters ---

    set preset(p)   { this._preset = p; }
    set dcOffset(v) { this._dcOffset = !!v; }

    // --- Public API ---

    /**
     * Request a Bluetooth device and connect.
     * Must be called from a user gesture (click handler).
     */
    async connect() {
      if (!navigator.bluetooth) throw new Error('Web Bluetooth not available');
      this._setStatus('connecting');
      this._log('info', 'Requesting Bluetooth device...');

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Muse' }],
        optionalServices: [MUSE_SERVICE],
      });
      this._device = device;
      this._log('info', 'Selected: ' + device.name);
      device.addEventListener('gattserverdisconnected', this._handleBLEDisconnect);

      this._log('info', 'Connecting GATT server...');
      this._server = await device.gatt.connect();

      this._log('info', 'Discovering service...');
      const svc = await this._server.getPrimaryService(MUSE_SERVICE);

      const [ctl, eeg, other] = await Promise.all([
        svc.getCharacteristic(CONTROL_UUID),
        svc.getCharacteristic(EEG_DATA_UUID),
        svc.getCharacteristic(OTHER_DATA_UUID),
      ]);
      this._controlChar = ctl;
      this._eegChar = eeg;
      this._otherChar = other;

      ctl.addEventListener('characteristicvaluechanged', this._handleBLEControl);
      await ctl.startNotifications();
      this._log('info', 'Subscribed: CONTROL');

      eeg.addEventListener('characteristicvaluechanged', this._handleBLEData);
      await eeg.startNotifications();
      this._log('info', 'Subscribed: EEG_DATA');

      other.addEventListener('characteristicvaluechanged', this._handleBLEData);
      await other.startNotifications();
      this._log('info', 'Subscribed: OTHER_DATA');

      this._setStatus('connected');
    }

    /**
     * Send the initialization sequence and start streaming.
     * @param {string} [preset] Override the preset (e.g. 'p1041')
     */
    async startStream(preset) {
      if (preset) this._preset = preset;
      this._setStatus('streaming');
      this._startProcessing();
      this._log('info', 'Starting stream (preset: ' + this._preset + ')...');
      await this._sendCmd('v6');   await wait(200);
      await this._sendCmd('s');    await wait(200);
      await this._sendCmd('h');    await wait(200);
      await this._sendCmd(this._preset); await wait(200);
      await this._sendCmd('s');    await wait(200);
      await this._sendCmd('dc001'); await wait(50);
      await this._sendCmd('dc001'); await wait(50);
      await this._sendCmd('L1');   await wait(300);
      await this._sendCmd('s');    await wait(200);
      this._log('info', 'Initialization complete.');
    }

    /** Stop the stream (halt command). */
    async stopStream() {
      try { await this._sendCmd('h'); } catch (_) {}
      this._stopProcessing();
      this._log('info', 'Stream halted.');
      if (this._status === 'streaming') this._setStatus('connected');
    }

    /** Disconnect from the device. */
    async disconnect() {
      try { await this._sendCmd('h'); } catch (_) {}
      this._stopProcessing();
      if (this._device && this._device.gatt.connected) this._device.gatt.disconnect();
    }

    /** Send an arbitrary command string to the device. */
    async sendCommand(cmd) {
      await this._sendCmd(cmd);
    }

    /**
     * Return structured export data (last N seconds).
     * @returns {Object}
     */
    getExportData() {
      const numEegCh = this._eegMode === 'EEG4' ? 4 : 8;
      return {
        exportedAt: new Date().toISOString(),
        libraryVersion: '2.0.0',
        connection: {
          deviceName: this.deviceName,
          firmware: this._firmware,
          preset: this._preset,
        },
        channels: {
          eeg: numEegCh === 4 ? EEG_LABELS_4 : EEG_LABELS_8,
          optics: OPTICS_CH_MAP[this._opticsNumCh] || [],
          accgyro: ACCGYRO_LABELS,
        },
        eegSamples: this._exp.eeg.map(s => ({ t: +(s.t.toFixed(2)), ch: s.ch.map(v => +(v.toFixed(3))) })),
        opticsSamples: this._exp.optics.map(s => ({ t: +(s.t.toFixed(2)), ch: s.ch.map(v => +(v.toFixed(6))) })),
        accgyroSamples: this._exp.accgyro.map(s => ({ t: +(s.t.toFixed(2)), ch: s.ch.map(v => +(v.toFixed(6))) })),
        battery: this._battery,
        processing: { ppg: this._ppg, fnirs: this._fnirs, bandPowers: this._bandPowers },
        rawPackets: this._exp.raw.map(p => ({ t: +(p.t.toFixed(2)), hex: p.hex })),
      };
    }

    /**
     * Download export data as a JSON file.
     * @param {string} [filename] Custom filename
     */
    downloadExport(filename) {
      const data = this.getExportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'athena-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // --- Internal: BLE event handlers ---

    _handleBLEDisconnect() {
      this._server = null;
      this._controlChar = null;
      this._eegChar = null;
      this._otherChar = null;
      this._stopProcessing();
      this._setStatus('disconnected');
      this._log('info', 'Device disconnected.');
    }

    _handleBLEControl(evt) {
      const bytes = new Uint8Array(evt.target.value.buffer, evt.target.value.byteOffset, evt.target.value.byteLength);
      const text = new TextDecoder().decode(bytes);
      this._log('rx', text.trim());
      const fw = text.match(/"fw"\s*:\s*"([^"]+)"/);
      if (fw) this._firmware = fw[1];
      const bp = text.match(/"bp"\s*:\s*([\d.]+)/);
      if (bp) { this._battery = parseFloat(bp[1]); if (this._onBatteryCb) this._onBatteryCb(this._battery); }
    }

    _handleBLEData(evt) {
      const ht = performance.now();
      const dv = evt.target.value;
      const buf = dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength);

      try {
        const pkts = parseNotification(buf, ht);
        for (const pkt of pkts) {
          this._counts.total++;
          this._pushExp(this._exp.raw, { t: ht, hex: toHex(pkt.raw) }, ht);
          if (this._onRawPacketCb) this._onRawPacketCb(pkt);

          for (const sub of pkt.subs) {
            if (sub.type === 'EEG')     this._handleEEG(sub, ht);
            else if (sub.type === 'OPTICS')  this._handleOptics(sub, ht);
            else if (sub.type === 'ACCGYRO') this._handleAccGyro(sub, ht);
            else if (sub.type === 'BATTERY') this._handleBattery(sub);
          }
        }
      } catch (e) {
        this._log('error', 'Parse error: ' + e.message);
      }
    }

    _handleEEG(sub, ht) {
      const cfg = TAG_CONFIG[sub.tag];
      this._counts.eeg++;
      if (!this._eegMode) {
        this._eegMode = cfg.name;
        this._log('info', 'EEG mode: ' + cfg.name + ' (' + cfg.ch + 'ch)');
      }
      const samples = decodeEEG(sub.data, cfg.ch, this._dcOffset);
      const labels = cfg.ch === 4 ? EEG_LABELS_4 : EEG_LABELS_8;
      for (const row of samples) {
        for (let c = 0; c < row.length; c++) this._eegBuf1s[c].push(row[c]);
        this._pushExp(this._exp.eeg, { t: ht, ch: Array.from(row) }, ht);
      }
      // Trim 1s buffers
      for (let c = 0; c < this._eegBuf1s.length; c++) {
        if (this._eegBuf1s[c].length > 512) this._eegBuf1s[c] = this._eegBuf1s[c].slice(-512);
      }
      if (this._onEEGCb) this._onEEGCb({ samples, labels, numCh: cfg.ch, count: this._counts.eeg });
    }

    _handleOptics(sub, ht) {
      const cfg = TAG_CONFIG[sub.tag];
      this._counts.optics++;
      if (!this._opticsMode) {
        this._opticsMode = cfg.name;
        this._opticsNumCh = cfg.ch;
        this._log('info', 'Optics mode: ' + cfg.name + ' (' + cfg.ch + 'ch)');
        this._startProcessing();
      }
      const samples = decodeOptics(sub.data, cfg.ch);
      const labels = OPTICS_CH_MAP[cfg.ch] || [];
      for (const row of samples) {
        this._opticsBuf.push(row);
        this._pushExp(this._exp.optics, { t: ht, ch: Array.from(row) }, ht);
      }
      if (this._opticsBuf.length > 2000) this._opticsBuf = this._opticsBuf.slice(-1920);
      if (this._onOpticsCb) this._onOpticsCb({ samples, labels, numCh: cfg.ch, count: this._counts.optics });
    }

    _handleAccGyro(sub, ht) {
      this._counts.accgyro++;
      const samples = decodeAccGyro(sub.data);
      for (const row of samples) {
        this._pushExp(this._exp.accgyro, { t: ht, ch: Array.from(row) }, ht);
      }
      if (this._onAccGyroCb) this._onAccGyroCb({ samples, labels: ACCGYRO_LABELS, count: this._counts.accgyro });
    }

    _handleBattery(sub) {
      this._counts.battery++;
      const pct = decodeBattery(sub.data);
      if (pct !== null) {
        this._battery = pct;
        this._log('info', 'Battery: ' + pct.toFixed(1) + '%');
        if (this._onBatteryCb) this._onBatteryCb(pct);
      }
    }

    // --- Internal: command sending ---

    async _sendCmd(cmd) {
      if (!this._controlChar) throw new Error('Not connected');
      const bytes = encodeCommand(cmd);
      this._log('tx', cmd);
      await this._controlChar.writeValueWithoutResponse(bytes.buffer);
    }

    // --- Internal: processing timer ---

    _startProcessing() {
      if (!this._processTimer) {
        this._processTimer = setInterval(() => this._processAll(), this._processInterval);
      }
    }

    _stopProcessing() {
      if (this._processTimer) { clearInterval(this._processTimer); this._processTimer = null; }
    }

    _processAll() {
      // Band powers (from frontal EEG channels AF7 + AF8)
      if (this._eegBuf1s[1].length >= 256) {
        const bp1 = computeBandPowers(this._eegBuf1s[1], 256);
        const bp2 = computeBandPowers(this._eegBuf1s[2], 256);
        if (bp1 && bp2) {
          this._bandPowers = {};
          for (const k of Object.keys(bp1)) this._bandPowers[k] = (bp1[k] + bp2[k]) / 2;
          if (this._onBandPowersCb) this._onBandPowersCb(this._bandPowers);
        }
      }
      // PPG
      if (this._opticsNumCh > 0 && this._opticsBuf.length >= 256) {
        const ppg = processPPGBatch(this._opticsBuf, this._opticsNumCh);
        if (ppg) { this._ppg = ppg; if (this._onPPGCb) this._onPPGCb(ppg); }
      }
      // fNIRS
      if (this._opticsNumCh >= 4 && this._opticsBuf.length >= 640) {
        const fnirs = processFNIRSBatch(this._opticsBuf, this._opticsNumCh);
        if (fnirs) { this._fnirs = fnirs; if (this._onFNIRSCb) this._onFNIRSCb(fnirs); }
      }
    }

    // --- Internal: export buffer management ---

    _pushExp(arr, item, now) {
      arr.push(item);
      const cutoff = now - this._exportSeconds * 1000;
      while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
    }

    // --- Internal: status & logging ---

    _setStatus(s) {
      this._status = s;
      if (this._onStatusCb) this._onStatusCb(s);
    }

    _log(type, msg) {
      if (this._onLogCb) this._onLogCb(type, msg);
    }

    // --- Static: self-test ---

    /**
     * Run the full validation suite. No hardware needed.
     * @returns {{ passed: boolean, results: Array<{name: string, ok: boolean}> }}
     */
    static selfTest() {
      const results = [];
      function check(name, ok) { results.push({ name, ok }); }

      check('BitUnpack: zeros -> 0', decodeBitPacked(new Uint8Array(28), 14, 16).every(v => v === 0));
      check('BitUnpack: 0xFF -> 16383', decodeBitPacked(new Uint8Array(28).fill(0xFF), 14, 16).every(v => v === 16383));

      { const b = new Uint8Array(28); b[0] = 0x01;
        check('BitUnpack: LSB set', decodeBitPacked(b, 14, 16)[0] === 1); }

      { const orig = [100,200,300,400,500,600,700,800,1000,2000,3000,4000,5000,6000,7000,8000];
        const b = new Uint8Array(28);
        for (let i = 0; i < 16; i++) for (let bit = 0; bit < 14; bit++)
          if ((orig[i] >> bit) & 1) { const p = i*14+bit; b[p>>3] |= 1 << (p&7); }
        check('BitUnpack: 14-bit round-trip', decodeBitPacked(b, 14, 16).every((v, i) => v === orig[i])); }

      { const orig = [100000,200000,300000,400000,500000,600000,700000,800000,
                      100001,200002,300003,400004,500005,600006,700007,800008];
        const b = new Uint8Array(40);
        for (let i = 0; i < 16; i++) for (let bit = 0; bit < 20; bit++)
          if ((orig[i] >> bit) & 1) { const p = i*20+bit; b[p>>3] |= 1 << (p&7); }
        check('BitUnpack: 20-bit round-trip', decodeBitPacked(b, 20, 16).every((v, i) => v === orig[i])); }

      { const samps = decodeEEG(new Uint8Array(28), 8, false);
        check('EEG: zeros -> 0 uV', samps[0].every(v => v === 0)); }

      { const samps = decodeEEG(new Uint8Array(28), 8, true);
        check('EEG: DC offset', Math.abs(samps[0][0] - (-DC_OFFSET_RAW * EEG_SCALE)) < 0.01); }

      check('Optics16: zeros -> 0', decodeOptics(new Uint8Array(40), 16)[0].every(v => v === 0));
      check('Optics4: 3 samples', decodeOptics(new Uint8Array(30), 4).length === 3);

      { const b = new Uint8Array(36); b[0] = 0x00; b[1] = 0x40;
        check('AccGyro: scale', Math.abs(decodeAccGyro(b)[0][0] - 16384 * ACC_SCALE) < 1e-6); }

      check('Battery: decode', Math.abs(decodeBattery(new Uint8Array([0x00, 0x50])) - 80.0) < 0.1);

      { const fs = 256, N = 256;
        const data = new Float64Array(N);
        for (let i = 0; i < N; i++) data[i] = Math.sin(2 * Math.PI * 10 * i / fs);
        const { psd, freqs } = computePowerSpectrum(data, fs);
        let maxP = 0, maxI = 0;
        for (let i = 1; i < psd.length; i++) if (psd[i] > maxP) { maxP = psd[i]; maxI = i; }
        check('FFT: 10 Hz peak', Math.abs(freqs[maxI] - 10) < 2); }

      { const data = new Float64Array(256);
        for (let i = 0; i < 256; i++) data[i] = Math.sin(2 * Math.PI * 10 * i / 256);
        const bp = computeBandPowers(data, 256);
        check('BandPower: alpha dominant', bp && bp.alpha > 0.5); }

      { const data = new Float64Array(100).fill(1.0);
        check('Biquad LPF: DC pass', Math.abs(filtfilt(biquadLPF(10, 256).b, biquadLPF(10, 256).a, data)[50] - 1.0) < 0.1); }

      { const eps = [[390, 1102.2], [1058, 691.32]];
        const dod730 = 390 * 1 + 1102.2 * 2, dod850 = 1058 * 1 + 691.32 * 2;
        const [hbo, hbr] = lstsq2(eps, [[dod730], [dod850]].map(v => new Float64Array(v)));
        check('mBLL: recovers HbO=1 HbR=2', Math.abs(hbo[0] - 1) < 0.01 && Math.abs(hbr[0] - 2) < 0.01); }

      { const data = new Float64Array(256);
        for (let i = 0; i < 256; i++) data[i] = Math.sin(2 * Math.PI * 1.5 * i / 64);
        check('PPG SQI: pulse signal', computePPGSQI(data, 64) > 0.5); }

      { const a = new Float64Array([1,2,3,4,5]), b = new Float64Array([-1,-2,-3,-4,-5]);
        check('AntiCorr: SQI ~ 1', Math.abs(computeAntiCorrelation(a, b) - 1) < 0.01); }

      return { passed: results.every(r => r.ok), results };
    }

    /** Available presets with metadata. */
    static get PRESETS() { return { ...PRESETS }; }

    /** Channel label constants. */
    static get CHANNELS() {
      return {
        EEG_8: [...EEG_LABELS_8], EEG_4: [...EEG_LABELS_4],
        ACCGYRO: [...ACCGYRO_LABELS],
        OPTICS_4: [...OPTICS_CH_MAP[4]], OPTICS_8: [...OPTICS_CH_MAP[8]], OPTICS_16: [...OPTICS_CH_MAP[16]],
      };
    }

    /** Scaling constants. */
    static get SCALES() {
      return { EEG: EEG_SCALE, OPTICS: OPTICS_SCALE, ACC: ACC_SCALE, GYRO: GYRO_SCALE, DC_OFFSET: DC_OFFSET_RAW };
    }

    /** BLE UUIDs. */
    static get UUIDS() {
      return { SERVICE: MUSE_SERVICE, CONTROL: CONTROL_UUID, EEG_DATA: EEG_DATA_UUID, OTHER_DATA: OTHER_DATA_UUID };
    }

    /** Check if Web Bluetooth is available. */
    static get isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }
  }

  // --- Utility (shared) ---
  function toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  // --- Export ---
  root.AthenaDevice = AthenaDevice;

})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
