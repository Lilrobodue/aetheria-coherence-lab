// viz/signal-panel.js
// Raw signal visualization panel. Creates a stacked set of PlotBase canvases
// for ECG/RR, EEG (4 channels), fNIRS, and PPG waveforms.

import { PlotBase } from './plot-base.js';

// 4 key plots for performance — one per regime + R-R
const SIGNAL_CONFIGS = [
  {
    stream: 'Aetheria_RR',
    title: 'R-R Intervals (ms)',
    color: '#00e676',
    windowSec: 60,
    filter: (payload) => payload.rr_ms !== null,
    extractValue: (payload) => payload.rr_ms
  },
  {
    stream: 'Aetheria_EEG',
    title: 'EEG AF7 / AF8',
    color: '#7c4dff',
    windowSec: 3,
    isBatched: true, // handled specially
    extractBatch: (payload) => ({ af7: payload.batch?.AF7, af8: payload.batch?.AF8 }),
    extraSeries: [{ label: 'AF8', color: '#e040fb' }]
  },
  {
    stream: 'Aetheria_PPG',
    title: 'PPG (BVP)',
    color: '#ffab40',
    windowSec: 5,
    isBatched: true,
    extractBatch: (payload) => payload.batch
  },
  {
    stream: 'Aetheria_fNIRS',
    title: 'fNIRS HbO / HbR',
    color: '#ff5252',
    windowSec: 10,
    extractValue: (payload) => payload.hbO,
    extraSeries: [
      { label: 'HbR', color: '#42a5f5', extractValue: (payload) => payload.hbR }
    ]
  }
];

export class SignalPanel {
  constructor(bus, containerEl) {
    this.bus = bus;
    this.container = containerEl;
    this._plots = [];
    this._unsubscribers = [];
    this._sampleCounts = {};
  }

  init() {
    this.container.innerHTML = '';
    this.container.classList.add('signal-panel');

    for (const config of SIGNAL_CONFIGS) {
      const wrapper = document.createElement('div');
      wrapper.className = 'signal-plot-wrapper';

      const canvas = document.createElement('canvas');
      canvas.className = 'signal-canvas';
      wrapper.appendChild(canvas);
      this.container.appendChild(wrapper);

      const plot = new PlotBase(canvas, {
        title: config.title,
        windowSec: config.windowSec,
        fps: 5,
        backgroundColor: '#0d0d1a',
        lineWidth: 1.2
      });

      const seriesIdx = plot.addSeries(config.title, config.color);

      // Extra series (e.g. fNIRS HbR alongside HbO, or EEG AF8 alongside AF7)
      const extraIndices = [];
      if (config.extraSeries) {
        for (const extra of config.extraSeries) {
          const extraEntry = {
            idx: plot.addSeries(extra.label, extra.color),
            extractValue: extra.extractValue,
            filter: extra.filter || null
          };
          extraIndices.push(extraEntry);

          // If the extra series has its own stream+filter, subscribe separately
          if (extra.stream && extra.filter) {
            const eidx = extraEntry.idx;
            const unsub2 = this.bus.subscribe(extra.stream, (payload) => {
              if (!extra.filter(payload)) return;
              const v = extra.extractValue(payload);
              if (v !== undefined && v !== null && isFinite(v)) {
                plot.pushSample(eidx, v, payload.timestamp);
              }
            });
            this._unsubscribers.push(unsub2);
          }
        }
      }

      // Track sample counts for debugging
      const countKey = config.title;
      this._sampleCounts[countKey] = 0;

      const unsub = this.bus.subscribe(config.stream, (payload) => {
        if (config.isBatched) {
          // Handle batched data (EEG, PPG)
          const batchData = config.extractBatch(payload);
          const t = payload.timestamp;

          if (config.stream === 'Aetheria_EEG' && batchData) {
            // EEG: AF7 is primary, AF8 is extra series
            const af7 = batchData.af7;
            const af8 = batchData.af8;
            if (af7) {
              plot.pushBatch(seriesIdx, af7, t, 1/256);
              this._sampleCounts[countKey] += af7.length;
            }
            if (af8 && extraIndices.length > 0) {
              plot.pushBatch(extraIndices[0].idx, af8, t, 1/256);
            }
          } else if (Array.isArray(batchData)) {
            // PPG: array of BVP values
            // Downsample for display: take every 4th sample
            for (let i = 0; i < batchData.length; i += 4) {
              plot.pushSample(seriesIdx, batchData[i], t + i / 64);
            }
            this._sampleCounts[countKey] += Math.ceil(batchData.length / 4);
          }
          return;
        }

        // Standard single-sample handling
        if (config.filter && !config.filter(payload)) return;
        const value = config.extractValue(payload);
        if (value !== undefined && value !== null && isFinite(value)) {
          plot.pushSample(seriesIdx, value, payload.timestamp);
          this._sampleCounts[countKey]++;
        }
        for (const extra of extraIndices) {
          if (extra.filter) continue;
          const v = extra.extractValue(payload);
          if (v !== undefined && v !== null && isFinite(v)) {
            plot.pushSample(extra.idx, v, payload.timestamp);
          }
        }
      });
      this._unsubscribers.push(unsub);

      this._plots.push({ plot, config, canvas, wrapper });
    }

    // Recalibrate all canvases now that all wrappers exist in the DOM.
    // Each PlotBase constructor sized its canvas when it was the only
    // child (100% height) — now flex distributes space evenly (25% each).
    requestAnimationFrame(() => this.resize());
  }

  start() {
    for (const { plot } of this._plots) {
      plot.start();
    }
  }

  stop() {
    for (const { plot } of this._plots) {
      plot.stop();
    }
  }

  resize() {
    for (const { plot } of this._plots) {
      plot.resize();
    }
  }

  // For debugging: returns sample counts per plot
  get sampleCounts() {
    return { ...this._sampleCounts };
  }

  dispose() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
    for (const { plot } of this._plots) plot.dispose();
    this._plots = [];
    this.container.innerHTML = '';
  }
}
