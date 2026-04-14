// viz/plot-base.js
// Lightweight Canvas-based plot helper. Redraws at configurable FPS.
// Handles: time-series line plots, auto-scaling Y axis, grid lines, labels.

export class PlotBase {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.options = {
      backgroundColor: '#1a1a2e',
      gridColor: 'rgba(255,255,255,0.08)',
      axisColor: 'rgba(255,255,255,0.3)',
      labelColor: 'rgba(255,255,255,0.6)',
      lineWidth: 1.5,
      fps: 10,
      windowSec: 5,          // visible time window
      yMin: null,             // null = auto-scale
      yMax: null,
      yPadding: 0.1,          // 10% padding on auto-scale
      showGrid: true,
      showLabels: true,
      title: '',
      titleColor: 'rgba(255,255,255,0.8)',
      ...options
    };

    this._series = [];        // { data: [], timestamps: [], color, label }
    this._animFrameId = null;
    this._lastDrawTime = 0;

    // Handle high-DPI displays
    this._setupHiDPI();
  }

  _setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this._width = rect.width;
    this._height = rect.height;
  }

  resize() {
    this._setupHiDPI();
  }

  addSeries(label, color = '#00ff88') {
    // Use fixed-size circular buffer for performance
    const maxSamples = Math.ceil((this.options.windowSec + 2) * 300); // headroom for high-rate signals
    const series = {
      data: new Float64Array(maxSamples),
      timestamps: new Float64Array(maxSamples),
      head: 0,        // write position
      count: 0,       // number of valid samples
      capacity: maxSamples,
      color,
      label
    };
    this._series.push(series);
    return this._series.length - 1;
  }

  // Push a single sample to a series
  pushSample(seriesIndex, value, timestamp) {
    const s = this._series[seriesIndex];
    if (!s) return;
    s.data[s.head] = value;
    s.timestamps[s.head] = timestamp;
    s.head = (s.head + 1) % s.capacity;
    if (s.count < s.capacity) s.count++;
  }

  // Push a batch of samples (more efficient than individual pushSample calls)
  pushBatch(seriesIndex, values, startTimestamp, sampleInterval) {
    const s = this._series[seriesIndex];
    if (!s) return;
    for (let i = 0; i < values.length; i++) {
      s.data[s.head] = values[i];
      s.timestamps[s.head] = startTimestamp + i * sampleInterval;
      s.head = (s.head + 1) % s.capacity;
      if (s.count < s.capacity) s.count++;
    }
  }

  // Get ordered samples within the visible time window (for drawing)
  _getVisibleSamples(series, tMin, tMax) {
    const s = series;
    if (s.count === 0) return { data: [], timestamps: [] };

    const data = [];
    const timestamps = [];
    const start = (s.head - s.count + s.capacity) % s.capacity;

    // Downsample if too many points for the canvas width
    const maxPoints = this._width || 800;
    let step = 1;
    if (s.count > maxPoints * 2) step = Math.floor(s.count / maxPoints);

    for (let i = 0; i < s.count; i += step) {
      const idx = (start + i) % s.capacity;
      const t = s.timestamps[idx];
      if (t >= tMin && t <= tMax) {
        data.push(s.data[idx]);
        timestamps.push(t);
      }
    }
    return { data, timestamps };
  }

  start() {
    if (this._animFrameId) return;
    const loop = () => {
      const now = performance.now();
      if (now - this._lastDrawTime >= 1000 / this.options.fps) {
        this._draw();
        this._lastDrawTime = now;
      }
      this._animFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  }

  _draw() {
    const { ctx, _width: w, _height: h, options } = this;
    const margin = { top: 25, right: 10, bottom: 20, left: 50 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    // Clear
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, w, h);

    if (this._series.length === 0 || this._series.every(s => s.count === 0)) {
      // Show plot title even while waiting so panels are identifiable
      if (options.title) {
        ctx.fillStyle = options.titleColor;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(options.title, 10, 18);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for data\u2026', w / 2, h / 2);
      ctx.textBaseline = 'alphabetic';
      return;
    }

    // Time range: latest timestamp - windowSec
    let tMax = -Infinity;
    for (const s of this._series) {
      if (s.count > 0) {
        const lastIdx = (s.head - 1 + s.capacity) % s.capacity;
        tMax = Math.max(tMax, s.timestamps[lastIdx]);
      }
    }
    const tMin = tMax - options.windowSec;

    // Get visible samples for all series (downsampled)
    const visibleData = this._series.map(s => this._getVisibleSamples(s, tMin, tMax));

    // Compute Y range across visible data
    let yMin = options.yMin;
    let yMax = options.yMax;
    if (yMin === null || yMax === null) {
      let allMin = Infinity, allMax = -Infinity;
      for (const vis of visibleData) {
        for (const v of vis.data) {
          if (isFinite(v)) {
            allMin = Math.min(allMin, v);
            allMax = Math.max(allMax, v);
          }
        }
      }
      if (!isFinite(allMin)) { allMin = -1; allMax = 1; }
      const range = allMax - allMin || 1;
      if (yMin === null) yMin = allMin - range * options.yPadding;
      if (yMax === null) yMax = allMax + range * options.yPadding;
    }

    // Draw grid
    if (options.showGrid) {
      ctx.strokeStyle = options.gridColor;
      ctx.lineWidth = 0.5;

      // Horizontal grid lines (5 lines)
      for (let i = 0; i <= 4; i++) {
        const y = margin.top + (i / 4) * plotH;
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + plotW, y);
        ctx.stroke();
      }

      // Vertical grid lines (1 per second)
      for (let t = Math.ceil(tMin); t <= tMax; t += 1) {
        const x = margin.left + ((t - tMin) / (tMax - tMin)) * plotW;
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotH);
        ctx.stroke();
      }
    }

    // Draw Y labels
    if (options.showLabels) {
      ctx.fillStyle = options.labelColor;
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const y = margin.top + (i / 4) * plotH;
        const val = yMax - (i / 4) * (yMax - yMin);
        ctx.fillText(this._formatValue(val), margin.left - 5, y + 3);
      }
    }

    // Title
    if (options.title) {
      ctx.fillStyle = options.titleColor;
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(options.title, margin.left, margin.top - 8);
    }

    // Draw each series from pre-fetched visible data
    for (let si = 0; si < this._series.length; si++) {
      const vis = visibleData[si];
      if (vis.data.length < 2) continue;

      ctx.strokeStyle = this._series[si].color;
      ctx.lineWidth = options.lineWidth;
      ctx.beginPath();

      const x0 = margin.left + ((vis.timestamps[0] - tMin) / (tMax - tMin)) * plotW;
      const y0 = margin.top + (1 - (vis.data[0] - yMin) / (yMax - yMin)) * plotH;
      ctx.moveTo(x0, Math.max(margin.top, Math.min(margin.top + plotH, y0)));

      for (let i = 1; i < vis.data.length; i++) {
        const x = margin.left + ((vis.timestamps[i] - tMin) / (tMax - tMin)) * plotW;
        const y = margin.top + (1 - (vis.data[i] - yMin) / (yMax - yMin)) * plotH;
        ctx.lineTo(x, Math.max(margin.top, Math.min(margin.top + plotH, y)));
      }

      ctx.stroke();
    }

    // Draw series labels (legend)
    if (this._series.length > 1) {
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i < this._series.length; i++) {
        const s = this._series[i];
        const x = w - margin.right - 5;
        const y = margin.top + 12 + i * 14;
        ctx.fillStyle = s.color;
        ctx.fillRect(x - 40, y - 8, 8, 8);
        ctx.fillStyle = options.labelColor;
        ctx.fillText(s.label, x, y);
      }
    }

    // Border
    ctx.strokeStyle = options.axisColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);
  }

  _formatValue(val) {
    const abs = Math.abs(val);
    if (abs >= 1000) return val.toFixed(0);
    if (abs >= 1) return val.toFixed(1);
    if (abs >= 0.01) return val.toFixed(3);
    return val.toExponential(1);
  }

  clear() {
    for (const s of this._series) {
      s.head = 0;
      s.count = 0;
    }
  }

  dispose() {
    this.stop();
    this._series = [];
  }
}
