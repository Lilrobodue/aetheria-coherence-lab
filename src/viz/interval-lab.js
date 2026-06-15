// viz/interval-lab.js
// The Interval Analysis Lab — Coherence Lab's research/deep-dive view for the
// shared IntervalAnalysis module (multi-app update spec, App 2: "show
// everything"). Opened from the header; renders into a full-screen modal.
//
// Sections:
//   1. Source tabs        — Session Cascade vs full 27-Frequency Library
//   2. Summary            — coherence score, classification, 3-6-9 gauge,
//                           counts, dominant regime, duration-vs-protocol
//   3. Number line        — "primes are the mountains, 3-6-9 is the river"
//   4. Score breakdown    — points contributed by each scoring category
//   5. Interval table     — every pairwise gap/ratio/match
//   6. Comparative        — load two sessions, contrast their fingerprints
//   7. Duration correlation — load many sessions, scatter minutes vs coherence
//   8. EEG cross-correlation — cascade coherence over time vs brain coherence
//
// Pure-ish view layer: all analysis comes from the injected IntervalAnalysis
// API and the interval-session helpers; this file only renders + handles input.

import {
  isPrime,
  analyzeSession,
  cumulativeCascadeCoherence,
  sessionDurationMinutes,
  extractPlayedPeaks,
} from '../coherence/interval-session.js';

const REGIME_COLORS = { GUT: '#ff9800', HEART: '#4caf50', HEAD: '#42a5f5' };

export class IntervalLab {
  /**
   * @param {object} opts
   * @param {object} opts.IA            - window.IntervalAnalysis
   * @param {object} [opts.PE]          - window.PrescriptionEngine (optional)
   * @param {Function} opts.getFrequencies - () => Array (27-frequency library)
   * @param {Function} opts.getLastSession - () => sessionJson | null
   */
  constructor({ IA, PE, getFrequencies, getLastSession }) {
    this.IA = IA;
    this.PE = PE || null;
    this.getFrequencies = getFrequencies;
    this.getLastSession = getLastSession;
    this.modal = null;
    this.source = 'cascade'; // 'cascade' | 'library'
    this._mounted = false;
  }

  mount() {
    if (this._mounted) return;
    const modal = document.createElement('div');
    modal.id = 'interval-lab-modal';
    modal.className = 'modal-overlay hidden';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:860px;">
        <h1>Interval Analysis Lab</h1>
        <p style="text-align:center;font-style:italic;color:var(--text-dim);margin-top:-18px;">
          Primes are the mountains. The space between is the river.
        </p>

        <div class="il-tabs" style="display:flex;gap:8px;justify-content:center;margin:18px 0;">
          <button class="btn il-tab" data-src="cascade">Session Cascade</button>
          <button class="btn il-tab" data-src="library">27-Frequency Library</button>
        </div>

        <div id="il-summary"></div>
        <div id="il-numberline"></div>
        <div id="il-breakdown"></div>
        <div id="il-table"></div>

        <div class="il-divider"></div>
        <h2>Comparative Analysis</h2>
        <p>Load two session files to contrast their interval fingerprints — the core research comparison between Aetheria-tuned and non-tuned material.</p>
        <div id="il-compare"></div>

        <div class="il-divider"></div>
        <h2>Duration vs Coherence</h2>
        <p>Load any number of session files. Each point is one session: does longer time, or a particular regime, correlate with higher coherence?</p>
        <div id="il-duration"></div>

        <div class="il-divider"></div>
        <h2>Brain ↔ Audio Coherence</h2>
        <p>Does mathematically coherent delivery produce measurably coherent brain states? Cascade coherence (the audio's harmonic structure as it builds) overlaid with your live biofield coherence over the session.</p>
        <div id="il-crosscorr"></div>

        <button id="interval-lab-close" class="modal-btn">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    this.modal = modal;

    // Tab switching
    modal.querySelectorAll('.il-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.source = btn.dataset.src;
        this._renderSourceSections();
        this._syncTabs();
      });
    });

    modal.querySelector('#interval-lab-close').addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) this.close();
    });

    this._buildComparative();
    this._buildDurationCorrelation();
    this._buildCrossCorrelation();
    this._mounted = true;
  }

  open() {
    if (!this._mounted) this.mount();
    // Reveal first so canvases have a measured width when we draw into them.
    this.modal.classList.remove('hidden');
    this.modal.scrollTop = 0;
    this._renderSourceSections();
    this._syncTabs();
    // Default the cross-correlation to the last session if one exists.
    const last = this.getLastSession && this.getLastSession();
    if (last) this._renderCrossCorr(last, 'Last session');
  }

  close() {
    if (this.modal) this.modal.classList.add('hidden');
  }

  // ─── source-dependent sections (summary, number line, breakdown, table) ───

  _syncTabs() {
    this.modal.querySelectorAll('.il-tab').forEach(btn => {
      const active = btn.dataset.src === this.source;
      btn.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
      btn.style.color = active ? 'var(--accent)' : 'var(--text-secondary)';
      btn.style.background = active ? 'rgba(124,77,255,0.12)' : 'var(--bg-panel)';
    });
  }

  _currentAnalysis() {
    const freqs = (this.getFrequencies && this.getFrequencies()) || [];
    const session = (this.getLastSession && this.getLastSession()) || null;
    const a = analyzeSession(session || { streams: {} }, this.IA, freqs);
    return { a, hasSession: !!session, freqs };
  }

  _renderSourceSections() {
    const { a, hasSession } = this._currentAnalysis();
    const analysis = this.source === 'cascade' ? a.cascade : a.library;
    const peaks = this.source === 'cascade' ? a.cascadePeaks : a.libPeaks;

    if (this.source === 'cascade' && !hasSession) {
      this.modal.querySelector('#il-summary').innerHTML =
        `<div class="il-empty">No completed session yet. Run a session, or switch to the
         <b>27-Frequency Library</b> tab to inspect the system's static interval structure.</div>`;
      this.modal.querySelector('#il-numberline').innerHTML = '';
      this.modal.querySelector('#il-breakdown').innerHTML = '';
      this.modal.querySelector('#il-table').innerHTML = '';
      return;
    }

    this._renderSummary(analysis, a, this.source);
    this._renderNumberLine(peaks);
    this._renderBreakdown(analysis);
    this._renderTable(analysis);
  }

  _renderSummary(analysis, full, source) {
    const s = analysis.summary;
    const fp = analysis.fingerprint;
    const el = this.modal.querySelector('#il-summary');
    const cls = analysis.classification;
    const regimeColor = REGIME_COLORS[s.regime] || 'var(--text-dim)';

    let durationHtml = '';
    if (source === 'cascade') {
      const d = full.duration;
      const statusColor = d.status === 'optimal' ? 'var(--success)'
        : d.status === 'extended' ? 'var(--head-color)' : 'var(--warning)';
      const icon = d.met ? '✅' : '⚠️';
      durationHtml = `
        <div class="il-card" style="flex:1 1 100%;">
          <div class="il-card-label">Duration vs Protocol</div>
          <div style="font-size:13px;color:var(--text-primary);">
            ${full.durationMinutes.toFixed(1)} min · ${full.regime} regime
            <span style="color:${statusColor};"> — ${icon} ${d.label}</span>
          </div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:2px;">
            ${full.regime}: ${d.protocol.min}–${d.protocol.max} min (optimal ${d.protocol.optimal}) · ${d.protocol.label}
          </div>
        </div>`;
    }

    el.innerHTML = `
      <div class="il-cards">
        <div class="il-card" style="flex:1 1 100%;">
          <div class="il-card-label">Coherence Score</div>
          <div class="il-scorebar">
            <div class="il-scorebar-fill" style="width:${s.score}%;"></div>
            <span class="il-scorebar-num">${s.score}</span>
          </div>
          <div style="margin-top:6px;font-size:14px;">
            <span style="color:var(--accent);">${cls.icon}</span>
            <b style="color:var(--text-primary);">${cls.label}</b>
            <span style="color:var(--text-dim);font-size:11px;"> (level ${cls.level}/4)</span>
          </div>
        </div>
        <div class="il-card">
          <div class="il-card-label">3-6-9 Ratio</div>
          ${gauge369(s.ratio369)}
        </div>
        <div class="il-card">
          <div class="il-card-label">Aetheria Intervals</div>
          <div class="il-bignum">${s.aetheriaIntervalCount}</div>
        </div>
        <div class="il-card">
          <div class="il-card-label">Harmonic Ratios</div>
          <div class="il-bignum">${s.harmonicRatioCount}</div>
        </div>
        <div class="il-card">
          <div class="il-card-label">Dominant Regime</div>
          <div class="il-bignum" style="color:${regimeColor};">${s.regime || '—'}</div>
        </div>
        <div class="il-card">
          <div class="il-card-label">Pairwise Intervals</div>
          <div class="il-bignum">${fp.totalIntervals}</div>
        </div>
        ${durationHtml}
      </div>`;
  }

  _renderNumberLine(peaks) {
    const el = this.modal.querySelector('#il-numberline');
    const freqs = (this.getFrequencies && this.getFrequencies()) || [];
    const librarySet = new Set(freqs.map(f => f.frequency_hz));
    el.innerHTML = `
      <div class="il-section-title">3-6-9 vs Prime — Mountains &amp; Rivers</div>
      <canvas class="il-canvas" style="height:120px;"></canvas>
      <div class="il-legend">
        <span><i style="background:#ffd54f"></i> Aetheria position</span>
        <span><i style="background:#4caf50"></i> 3-6-9 / ÷3</span>
        <span><i style="background:#ff5252"></i> prime</span>
        <span><i style="background:#9e9e9e"></i> other</span>
        <span style="color:var(--text-dim)">numbers between = gap (Hz)</span>
      </div>`;
    const canvas = el.querySelector('canvas');
    drawNumberLine(canvas, peaks, librarySet, this.IA);
  }

  _renderBreakdown(analysis) {
    const el = this.modal.querySelector('#il-breakdown');
    const intervals = analysis.intervals;
    let aeth = 0, harm = 0, r369 = 0, div3 = 0;
    for (const iv of intervals) {
      if (iv.aetheriaInterval.match) aeth += Math.max(0, 10 - iv.aetheriaInterval.deviation);
      if (iv.harmonicRatio.match) harm += Math.max(0, 10 - iv.harmonicRatio.deviation * 100);
      if (iv.gapIs369) r369 += 5;
      if (iv.gapDivisibleBy3) div3 += 5;
    }
    const maxPossible = intervals.length * 30 || 1;
    const rows = [
      { label: 'Aetheria interval match', pts: aeth, max: intervals.length * 10, color: 'var(--accent)' },
      { label: 'Harmonic ratio match', pts: harm, max: intervals.length * 10, color: '#42a5f5' },
      { label: 'Digital root 3-6-9', pts: r369, max: intervals.length * 5, color: '#4caf50' },
      { label: 'Divisible by 3', pts: div3, max: intervals.length * 5, color: '#ff9800' },
    ];
    el.innerHTML = `
      <div class="il-section-title">Score Breakdown</div>
      ${rows.map(r => `
        <div class="il-bd-row">
          <span class="il-bd-label">${r.label}</span>
          <span class="il-bd-bar"><span style="width:${r.max ? (r.pts / r.max) * 100 : 0}%;background:${r.color};"></span></span>
          <span class="il-bd-val">${r.pts.toFixed(0)} / ${r.max.toFixed(0)}</span>
        </div>`).join('')}
      <div style="font-size:10px;color:var(--text-dim);margin-top:4px;">
        Total ${(aeth + harm + r369 + div3).toFixed(0)} of ${maxPossible} possible →
        normalized score ${analysis.summary.score}/100
      </div>`;
  }

  _renderTable(analysis) {
    const el = this.modal.querySelector('#il-table');
    const intervals = analysis.intervals;
    if (!intervals.length) {
      el.innerHTML = `<div class="il-section-title">Interval Table</div>
        <div class="il-empty">Need at least two distinct frequencies to form an interval.</div>`;
      return;
    }
    const rows = intervals.map(iv => {
      const aeth = iv.aetheriaInterval.match
        ? `${iv.aetheriaInterval.regime}×${iv.aetheriaInterval.multiplier}` : '—';
      const harm = iv.harmonicRatio.match ? iv.harmonicRatio.name : '—';
      const flag369 = iv.gapIs369 ? '<span style="color:#4caf50">✓</span>' : '';
      return `<tr>
        <td>${fmtHz(iv.from.hz)}</td>
        <td>${fmtHz(iv.to.hz)}</td>
        <td>${iv.gap.toFixed(0)}</td>
        <td>${iv.ratio.toFixed(3)}</td>
        <td>${iv.gapDigitalRoot} ${flag369}</td>
        <td style="color:${iv.aetheriaInterval.match ? 'var(--accent)' : 'var(--text-dim)'}">${aeth}</td>
        <td style="color:${iv.harmonicRatio.match ? 'var(--head-color)' : 'var(--text-dim)'}">${harm}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <div class="il-section-title">Interval Table <span style="color:var(--text-dim);font-weight:normal;">(${intervals.length} pairs)</span></div>
      <div class="il-table-scroll">
        <table class="il-tbl">
          <thead><tr><th>From</th><th>To</th><th>Gap</th><th>Ratio</th><th>DR</th><th>Aetheria</th><th>Harmonic</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ─── comparative analysis ───

  _buildComparative() {
    const el = this.modal.querySelector('#il-compare');
    el.innerHTML = `
      <div class="il-cmp-inputs">
        <label class="il-file">Session A<input type="file" accept="application/json" data-slot="A"></label>
        <label class="il-file">Session B<input type="file" accept="application/json" data-slot="B"></label>
      </div>
      <div id="il-cmp-result"></div>`;
    this._cmp = { A: null, B: null };
    el.querySelectorAll('input[type=file]').forEach(inp => {
      inp.addEventListener('change', (e) => this._onCompareFile(e, inp.dataset.slot));
    });
  }

  async _onCompareFile(e, slot) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const freqs = (this.getFrequencies && this.getFrequencies()) || [];
      const a = analyzeSession(json, this.IA, freqs);
      this._cmp[slot] = { name: file.name, a };
    } catch (err) {
      this._cmp[slot] = { name: file.name, error: err.message };
    }
    this._renderCompare();
  }

  _renderCompare() {
    const out = this.modal.querySelector('#il-cmp-result');
    const A = this._cmp.A, B = this._cmp.B;
    const line = (slot, d) => {
      if (!d) return `<div class="il-cmp-row il-empty">Session ${slot}: not loaded</div>`;
      if (d.error) return `<div class="il-cmp-row" style="color:var(--error)">Session ${slot}: ${d.error}</div>`;
      const s = d.a.cascade.summary;
      return `<div class="il-cmp-row">
        <b>${slot}</b> <span class="il-cmp-name">${d.name}</span>
        <span>Coherence <b>${s.score}</b></span>
        <span>3-6-9 <b>${(s.ratio369 * 100).toFixed(0)}%</b></span>
        <span>Aetheria <b>${s.aetheriaIntervalCount}</b></span>
        <span>${s.icon} ${s.label}</span>
      </div>`;
    };
    let delta = '';
    if (A && A.a && B && B.a) {
      const sa = A.a.cascade.summary, sb = B.a.cascade.summary;
      const d = (x) => (x >= 0 ? '+' : '') + x;
      delta = `<div class="il-cmp-row il-cmp-delta">
        <b>Δ (A−B)</b>
        <span>Coherence <b>${d(sa.score - sb.score)}</b></span>
        <span>3-6-9 <b>${d(Math.round((sa.ratio369 - sb.ratio369) * 100))}%</b></span>
        <span>Aetheria <b>${d(sa.aetheriaIntervalCount - sb.aetheriaIntervalCount)}</b></span>
      </div>`;
    }
    out.innerHTML = line('A', A) + line('B', B) + delta;
  }

  // ─── duration correlation ───

  _buildDurationCorrelation() {
    const el = this.modal.querySelector('#il-duration');
    el.innerHTML = `
      <label class="il-file">Load sessions<input type="file" accept="application/json" multiple data-slot="dur"></label>
      <canvas class="il-canvas" style="height:200px;"></canvas>
      <div id="il-dur-summary" class="il-legend"></div>`;
    this._durPoints = [];
    el.querySelector('input[type=file]').addEventListener('change', (e) => this._onDurationFiles(e));
  }

  async _onDurationFiles(e) {
    const files = Array.from(e.target.files || []);
    const freqs = (this.getFrequencies && this.getFrequencies()) || [];
    for (const file of files) {
      try {
        const json = JSON.parse(await file.text());
        const a = analyzeSession(json, this.IA, freqs);
        this._durPoints.push({
          name: file.name,
          minutes: a.durationMinutes,
          score: a.cascade.summary.score,
          regime: a.regime,
        });
      } catch (_) { /* skip unparseable */ }
    }
    this._renderDuration();
  }

  _renderDuration() {
    const canvas = this.modal.querySelector('#il-duration canvas');
    drawScatter(canvas, this._durPoints);
    const sum = this.modal.querySelector('#il-dur-summary');
    if (!this._durPoints.length) { sum.innerHTML = '<span class="il-empty">No sessions loaded.</span>'; return; }
    const n = this._durPoints.length;
    const avg = (k) => this._durPoints.reduce((s, p) => s + p[k], 0) / n;
    sum.innerHTML = `
      <span>${n} session${n > 1 ? 's' : ''}</span>
      <span>avg duration <b>${avg('minutes').toFixed(1)} min</b></span>
      <span>avg coherence <b>${avg('score').toFixed(0)}</b></span>
      <span style="color:var(--text-dim)">color = dominant regime</span>`;
  }

  // ─── EEG / audio cross-correlation ───

  _buildCrossCorrelation() {
    const el = this.modal.querySelector('#il-crosscorr');
    el.innerHTML = `
      <label class="il-file">Load a full session (or uses your last)<input type="file" accept="application/json" data-slot="xcorr"></label>
      <canvas class="il-canvas" style="height:200px;"></canvas>
      <div class="il-legend">
        <span><i style="background:#ffd54f"></i> cascade coherence (audio)</span>
        <span><i style="background:#7c4dff"></i> TCS (biofield)</span>
        <span><i style="background:#42a5f5"></i> HEAD coherence (EEG)</span>
      </div>
      <div id="il-xcorr-note" class="il-legend"></div>`;
    el.querySelector('input[type=file]').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        this._renderCrossCorr(json, file.name);
      } catch (err) {
        this.modal.querySelector('#il-xcorr-note').innerHTML =
          `<span style="color:var(--error)">${err.message}</span>`;
      }
    });
  }

  _renderCrossCorr(sessionJson, label) {
    const canvas = this.modal.querySelector('#il-crosscorr canvas');
    const cascade = cumulativeCascadeCoherence(sessionJson, this.IA);
    const coh = (sessionJson.streams && sessionJson.streams.coherence) || [];
    drawCrossCorr(canvas, cascade, coh);
    const note = this.modal.querySelector('#il-xcorr-note');
    const peaks = extractPlayedPeaks(sessionJson).length;
    const mins = sessionDurationMinutes(sessionJson).toFixed(1);
    note.innerHTML = `<span style="color:var(--text-dim)">Source: ${label} · ${peaks} distinct frequencies · ${mins} min · ${coh.length} coherence samples</span>`;
  }
}

// ════════════════════════ rendering helpers ════════════════════════

function fmtHz(hz) { return Number.isInteger(hz) ? `${hz}` : hz.toFixed(1); }

function gauge369(ratio) {
  const pct = Math.round((ratio || 0) * 100);
  const color = pct >= 70 ? '#4caf50' : pct >= 50 ? '#ffc107' : '#ff5252';
  return `<div class="il-gauge">
      <div class="il-gauge-track"><div class="il-gauge-fill" style="width:${pct}%;background:${color};"></div></div>
      <div class="il-bignum" style="color:${color};">${pct}<span style="font-size:11px;">%</span></div>
    </div>`;
}

function hiDpiCtx(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.parentElement.clientWidth || 600;
  const h = cssHeight || rect.height || 160;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function markerColor(hz, librarySet, IA) {
  if (librarySet.has(Math.round(hz)) || librarySet.has(hz)) return '#ffd54f'; // gold = Aetheria position
  if (IA.is369(Math.round(hz)) || Math.round(hz) % 3 === 0) return '#4caf50'; // green = river
  if (isPrime(hz)) return '#ff5252';                                          // red = mountain
  return '#9e9e9e';
}

function drawNumberLine(canvas, peaks, librarySet, IA) {
  const { ctx, w, h } = hiDpiCtx(canvas, 120);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, w, h);
  const sorted = peaks.filter(p => isFinite(p.hz)).slice().sort((a, b) => a.hz - b.hz);
  if (sorted.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '13px monospace';
    ctx.textAlign = 'center'; ctx.fillText('No frequencies to plot', w / 2, h / 2);
    return;
  }
  const pad = 36;
  const minHz = sorted[0].hz, maxHz = sorted[sorted.length - 1].hz;
  const span = (maxHz - minHz) || 1;
  const x = (hz) => pad + ((hz - minHz) / span) * (w - 2 * pad);
  const axisY = h * 0.62;

  // axis
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, axisY); ctx.lineTo(w - pad, axisY); ctx.stroke();

  // gap labels between consecutive peaks
  ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].hz - sorted[i - 1].hz;
    const mx = (x(sorted[i].hz) + x(sorted[i - 1].hz)) / 2;
    const is369gap = IA.is369(Math.round(gap));
    ctx.fillStyle = is369gap ? 'rgba(76,175,80,0.9)' : 'rgba(255,255,255,0.4)';
    ctx.fillText(gap.toFixed(0), mx, axisY - 10);
  }

  // markers
  for (const p of sorted) {
    const px = x(p.hz);
    ctx.fillStyle = markerColor(p.hz, librarySet, IA);
    ctx.beginPath(); ctx.arc(px, axisY, 5, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(px, axisY + 12); ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
    ctx.fillText(fmtHz(p.hz), 0, 0);
    ctx.restore();
  }
}

function drawScatter(canvas, points) {
  const { ctx, w, h } = hiDpiCtx(canvas, 200);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, w, h);
  const m = { l: 40, r: 12, t: 12, b: 28 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  // axes
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, m.t + ph); ctx.lineTo(m.l + pw, m.t + ph); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px monospace';
  ctx.textAlign = 'center'; ctx.fillText('duration (min)', m.l + pw / 2, h - 6);
  ctx.save(); ctx.translate(11, m.t + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('coherence', 0, 0); ctx.restore();
  if (!points.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.textAlign = 'center';
    ctx.fillText('Load sessions to plot', m.l + pw / 2, m.t + ph / 2); return;
  }
  const maxMin = Math.max(60, ...points.map(p => p.minutes));
  const X = (v) => m.l + (v / maxMin) * pw;
  const Y = (v) => m.t + (1 - v / 100) * ph;
  // y gridlines at 0/25/50/75/100
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'right';
  for (let v = 0; v <= 100; v += 25) {
    ctx.beginPath(); ctx.moveTo(m.l, Y(v)); ctx.lineTo(m.l + pw, Y(v)); ctx.stroke();
    ctx.fillText(v, m.l - 4, Y(v) + 3);
  }
  for (const p of points) {
    ctx.fillStyle = REGIME_COLORS[p.regime] || '#9e9e9e';
    ctx.beginPath(); ctx.arc(X(p.minutes), Y(p.score), 5, 0, Math.PI * 2); ctx.fill();
  }
}

function drawCrossCorr(canvas, cascade, coherence) {
  const { ctx, w, h } = hiDpiCtx(canvas, 200);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, w, h);
  const m = { l: 36, r: 12, t: 12, b: 24 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, m.t + ph); ctx.lineTo(m.l + pw, m.t + ph); ctx.stroke();

  const cohT = coherence.map(c => c.t).filter(isFinite);
  const tMax = Math.max(
    cascade.length ? cascade[cascade.length - 1].t : 0,
    cohT.length ? cohT[cohT.length - 1] : 0,
    1
  );
  const X = (t) => m.l + (t / tMax) * pw;
  const Y = (v) => m.t + (1 - v / 100) * ph; // all series normalized to 0..100

  if (!cascade.length && !coherence.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
    ctx.fillText('No time-series data in this session', m.l + pw / 2, m.t + ph / 2); return;
  }

  // cascade coherence (step line, already 0..100)
  drawLine(ctx, cascade.map(p => [X(p.t), Y(p.score)]), '#ffd54f', true);
  // TCS (already ~0..100)
  drawLine(ctx, coherence.filter(c => isFinite(c.tcs)).map(c => [X(c.t), Y(c.tcs)]), '#7c4dff', false);
  // HEAD coherence (0..1 → scale to 0..100)
  drawLine(ctx, coherence.filter(c => isFinite(c.head)).map(c => [X(c.t), Y(c.head * 100)]), '#42a5f5', false);

  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
  ctx.fillText('session time (s)', m.l + pw / 2, h - 4);
}

function drawLine(ctx, pts, color, stepped) {
  if (pts.length < 1) return;
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    if (stepped) ctx.lineTo(pts[i][0], pts[i - 1][1]);
    ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.stroke();
  if (pts.length === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 3, 0, Math.PI * 2); ctx.fill(); }
}
