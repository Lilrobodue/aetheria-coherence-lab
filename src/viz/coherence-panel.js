// viz/coherence-panel.js
// Biofield Coherence Score alignment visualization.
// Shows the three regimes (GUT/HEART/HEAD) as concentric arcs with a
// central TCS gauge. Updates from Aetheria_Coherence events (Phase 3)
// and shows live HR data from Aetheria_RR in the meantime.

export class CoherencePanel {
  constructor(bus) {
    this.bus = bus;
    this._canvas = null;
    this._ctx = null;
    this._animId = null;
    this._unsubscribers = [];

    // Live values
    this._tcs = 0;
    this._gut = 0;
    this._heart = 0;
    this._head = 0;
    this._plv = 0;
    this._hr = 0;
    this._deficit = 'NONE';
    this._lead = 'NONE';
    // Calibrated 2026-04-17 after session analysis: BCS may be null on
    // ticks where sharedEnergy could not be measured. Track the quality
    // flags alongside the value so the gap can be shown explicitly.
    this._bcs = null;
    this._bcsQuality = null;
    this._sharedEnergyQuality = null;
    this._phaseTransition = false;
    this._state = 'IDLE';
  }

  init(container) {
    this._canvas = document.createElement('canvas');
    this._canvas.className = 'coherence-canvas';
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    container.appendChild(this._canvas);

    this._setupHiDPI();

    // Subscribe to coherence vector (Phase 3 — real TCS + regime scores)
    const fin = (v, fallback = 0) => isFinite(v) ? v : fallback;
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_Coherence', (p) => {
        this._tcs = fin(p.tcs);
        this._gut = fin(p.gut);
        this._heart = fin(p.heart);
        this._head = fin(p.head);
        this._plv = fin(p.triunePLV);
        if (p.deficit) this._deficit = p.deficit;
        if (p.lead) this._lead = p.lead;
      })
    );

    // Subscribe to HR for center display
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_RR', (p) => {
        if (p.hr_bpm) this._hr = p.hr_bpm;
      })
    );

    // Subscribe to BCS (Phase 7: proof layer).
    // Preserve null for no-measurement ticks so the display shows a gap
    // rather than zero-dipping.
    this._unsubscribers.push(
      this.bus.subscribe('Aetheria_BCS', (p) => {
        this._bcs = (p.bcs != null && isFinite(p.bcs)) ? p.bcs : null;
        this._bcsQuality = p.bcsQuality || null;
        this._sharedEnergyQuality = p.sharedEnergyQuality || null;
        this._phaseTransition = p.phaseTransition?.detected || false;
      })
    );
  }

  _setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this._canvas.getBoundingClientRect();
    this._canvas.width = rect.width * dpr;
    this._canvas.height = rect.height * dpr;
    this._ctx = this._canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);
    this._w = rect.width;
    this._h = rect.height;
  }

  resize() { this._setupHiDPI(); }

  start() {
    const loop = () => {
      this._draw();
      this._animId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    if (this._animId) cancelAnimationFrame(this._animId);
    this._animId = null;
  }

  _draw() {
    const { _ctx: ctx, _w: w, _h: h } = this;
    if (!ctx || w === 0) return;

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(cx, cy) - 20;

    // Background
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, w, h);

    // Three concentric regime arcs
    const regimes = [
      { name: 'HEAD',  value: this._head,  color: '#42a5f5', radius: maxR },
      { name: 'HEART', value: this._heart, color: '#4caf50', radius: maxR * 0.72 },
      { name: 'GUT',   value: this._gut,   color: '#ff9800', radius: maxR * 0.44 },
    ];

    for (const r of regimes) {
      // Background arc (dim)
      ctx.beginPath();
      ctx.arc(cx, cy, r.radius, -Math.PI * 0.75, Math.PI * 0.75);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = maxR * 0.15;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Value arc
      const sweep = Math.PI * 1.5; // total arc span
      const startAngle = -Math.PI * 0.75;
      const endAngle = startAngle + sweep * Math.max(0.01, r.value);
      ctx.beginPath();
      ctx.arc(cx, cy, r.radius, startAngle, endAngle);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = maxR * 0.13;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.3 + r.value * 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Label
      const labelAngle = -Math.PI * 0.75 - 0.3;
      const lx = cx + Math.cos(labelAngle) * r.radius;
      const ly = cy + Math.sin(labelAngle) * r.radius;
      ctx.fillStyle = r.color;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(r.name, lx - 5, ly + 3);

      // Percentage
      const pctAngle = Math.PI * 0.75 + 0.3;
      const px = cx + Math.cos(pctAngle) * r.radius;
      const py = cy + Math.sin(pctAngle) * r.radius;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${(r.value * 100).toFixed(0)}%`, px + 5, py + 3);
    }

    // Center: TCS or HR
    const tcsValue = this._tcs || 0;
    const centerValue = tcsValue > 0 ? tcsValue.toFixed(0) : this._hr > 0 ? this._hr.toFixed(0) : '--';
    const centerLabel = tcsValue > 0 ? 'TCS' : this._hr > 0 ? 'BPM' : '';

    // TCS color: red < 40, yellow 40-70, green > 70
    let centerColor = '#ffffff';
    if (tcsValue > 0) {
      if (tcsValue >= 70) centerColor = '#00e676';
      else if (tcsValue >= 40) centerColor = '#ffc107';
      else centerColor = '#ff5252';
    } else if (this._hr > 0) {
      centerColor = '#4caf50';
    }

    ctx.fillStyle = centerColor;
    ctx.font = `bold ${maxR * 0.35}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(centerValue, cx, cy - 5);

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `${maxR * 0.12}px monospace`;
    ctx.fillText(centerLabel, cx, cy + maxR * 0.2);

    // Title
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BIOFIELD COHERENCE', cx, 14);

    // Bottom info: BCS + PLV + deficit/lead
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const infoY = h - 6;

    // BCS (the truth score). Null means the last tick had no valid
    // measurement (e.g., MEMD could not produce a shared-energy value).
    // Render as "BCS --" with the quality flag below, in the tertiary
    // color, so the user sees a signal-quality gap rather than a zero dip.
    if (this._bcs != null && this._bcs > 0) {
      const bcsColor = this._bcs >= 70 ? '#00e676' : this._bcs >= 40 ? '#ffc107' : '#ff5252';
      ctx.fillStyle = bcsColor;
      const partialMark = this._bcsQuality === 'partial' ? '*' : '';
      ctx.fillText(`BCS ${this._bcs.toFixed(0)}${partialMark}`, cx - 70, infoY);
      if (this._phaseTransition) {
        ctx.fillStyle = '#e040fb';
        ctx.fillText('UNIFIED', cx - 70, infoY - 11);
      }
    } else if (this._sharedEnergyQuality && this._sharedEnergyQuality !== 'ok') {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText('BCS --', cx - 70, infoY);
      ctx.font = '8px monospace';
      ctx.fillText(`signal: ${this._sharedEnergyQuality}`, cx - 70, infoY - 10);
      ctx.font = '9px monospace';
    }

    if (this._plv > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText(`PLV ${this._plv.toFixed(2)}`, cx, infoY);
    }

    if (this._lead !== 'NONE') {
      const leadColor = this._lead === 'GUT' ? '#ff9800' : this._lead === 'HEART' ? '#4caf50' : '#42a5f5';
      ctx.fillStyle = leadColor;
      ctx.fillText(`Lead: ${this._lead}`, cx + 70, infoY);
    }
  }

  dispose() {
    this.stop();
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }
}
