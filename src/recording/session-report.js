// recording/session-report.js
// Generates the post-session summary report from Doc 3 §6.
// This is the post-session reflection material and the labeled
// training data for the eventual v2 ML policy.

/**
 * Generate a session report from recorded session data.
 *
 * @param {object} sessionJson - from SessionRecorder.toJSON()
 * @returns {object} structured report
 */
export function generateReport(sessionJson) {
  const { metadata, streams } = sessionJson;
  const coherence = streams.coherence || [];
  const state = streams.state || [];
  const prescriptions = streams.prescription || [];

  // Duration
  const duration = coherence.length > 0
    ? coherence[coherence.length - 1].t - coherence[0].t
    : 0;

  // TCS statistics
  const tcsValues = coherence.map(c => c.tcs).filter(v => isFinite(v));
  const baselineTcs = tcsValues.length > 10 ? tcsValues.slice(0, 10).reduce((a, b) => a + b, 0) / 10 : 0;
  const finalTcs = tcsValues.length > 0 ? tcsValues[tcsValues.length - 1] : 0;
  const peakTcs = tcsValues.length > 0 ? Math.max(...tcsValues) : 0;
  const peakTcsIdx = tcsValues.indexOf(peakTcs);
  const peakTcsTime = coherence[peakTcsIdx]?.t || 0;

  // Frequencies played
  const played = prescriptions
    .filter(p => p.action === 'play' && p.freq)
    .map(p => ({ freq: p.freq, regime: p.regime, name: p.name, time: p.t }));

  // Compute per-frequency stats from coherence data
  const frequenciesPlayed = [];
  for (let i = 0; i < played.length; i++) {
    const startTime = played[i].time;
    const endTime = played[i + 1]?.time || (coherence.length > 0 ? coherence[coherence.length - 1].t : startTime);

    const coherenceDuring = coherence.filter(c => c.t >= startTime && c.t < endTime);
    const tcsStart = coherenceDuring[0]?.tcs || 0;
    const tcsEnd = coherenceDuring.length > 0 ? coherenceDuring[coherenceDuring.length - 1].tcs : tcsStart;

    // Find the decision that ended this frequency
    const nextTransition = state.find(s => s.t >= endTime - 1 && s.from === 'EVALUATE');
    const decision = nextTransition?.reason?.split(':')[0] || 'END';

    frequenciesPlayed.push({
      freq: played[i].freq,
      regime: played[i].regime,
      name: played[i].name,
      duration: +(endTime - startTime).toFixed(0),
      tcsDelta: +(tcsEnd - tcsStart).toFixed(1),
      decision
    });
  }

  // Count decisions
  const decisions = state.filter(s => s.from === 'EVALUATE');
  const pivots = decisions.filter(d => d.reason?.includes('PIVOT')).length;
  const holds = decisions.filter(d => d.reason?.includes('HOLD') || d.reason?.includes('Giving')).length;
  const advances = decisions.filter(d => d.reason?.includes('ADVANCE') || d.reason?.includes('Strong') || d.reason?.includes('Peak was') || d.reason?.includes('plateau')).length;

  // Deficit at start/end
  const deficitAtStart = coherence.length > 10 ? coherence[10].deficit : 'NONE';
  const deficitAtEnd = coherence.length > 0 ? coherence[coherence.length - 1].deficit : 'NONE';

  // PLV at start/end
  const plvAtStart = coherence.length > 10 ? coherence[10].plv : 0;
  const plvAtEnd = coherence.length > 0 ? coherence[coherence.length - 1].plv : 0;

  return {
    sessionId: metadata.sessionId,
    userId: metadata.userId,
    startTime: metadata.startTime,
    endTime: metadata.endTime,
    durationSec: +duration.toFixed(0),
    baselineTcs: +baselineTcs.toFixed(1),
    finalTcs: +finalTcs.toFixed(1),
    peakTcs: +peakTcs.toFixed(1),
    peakTcsTime: +peakTcsTime.toFixed(0),
    frequenciesPlayed,
    pivots,
    holds,
    advances,
    deficitAtStart,
    deficitAtEnd,
    triunePlvAtStart: +plvAtStart.toFixed(2),
    triunePlvAtEnd: +plvAtEnd.toFixed(2),
    totalCoherenceSamples: coherence.length,
    totalRRSamples: (streams.rr || []).length
  };
}
