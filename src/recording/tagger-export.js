// recording/tagger-export.js
// Builds a filtered JSON export for the Aetheria Session Tagger.
// Pure function — takes the full session JSON, returns the subset per the data contract.

export const TAGGER_URL = 'https://aetheria-session-tagger.org';

export function buildTaggerExport(fullSessionJSON) {
  const { metadata, streams } = fullSessionJSON;
  const coherence = streams.coherence || [];
  const bcs = streams.bcs || [];
  const state = streams.state || [];
  const prescription = streams.prescription || [];

  // Duration from ISO timestamps
  const startMs = metadata.startTime ? new Date(metadata.startTime).getTime() : 0;
  const endMs = metadata.endTime ? new Date(metadata.endTime).getTime() : startMs;
  const durationSeconds = Math.round((endMs - startMs) / 1000);

  // TCS stats
  const tcsValues = coherence.map(c => c.tcs).filter(v => isFinite(v));
  const peakTcs = tcsValues.length > 0 ? Math.max(...tcsValues) : 0;
  const meanTcs = tcsValues.length > 0
    ? tcsValues.reduce((a, b) => a + b, 0) / tcsValues.length : 0;

  // BCS stats (null if no BCS stream — older sessions predate v1.3 Phase 7)
  const bcsValues = bcs.map(b => b.bcs).filter(v => isFinite(v));
  const hasBcs = bcsValues.length > 0;
  const peakBcs = hasBcs ? Math.max(...bcsValues) : null;
  const meanBcs = hasBcs
    ? bcsValues.reduce((a, b) => a + b, 0) / bcsValues.length : null;

  // Phase transition
  const phaseTransitionEntry = bcs.find(b => b.phaseTransition === true);
  const phaseTransitionDetected = !!phaseTransitionEntry;
  const phaseTransitionTimeSeconds = phaseTransitionEntry
    ? phaseTransitionEntry.t : null;

  // Harm stats
  const harmValues = coherence.map(c => c.harm).filter(v => isFinite(v));
  const harmOneCount = harmValues.filter(v => v === 1.0).length;
  const harmMean = harmValues.length > 0
    ? harmValues.reduce((a, b) => a + b, 0) / harmValues.length : 0;

  // Cascade flips: state transitions with "flipped" in the reason
  const cascadeFlips = state.filter(
    s => s.reason && s.reason.toLowerCase().includes('flipped')
  ).length;

  // Prescriptions with action === 'play'
  const prescriptionsCount = prescription.filter(p => p.action === 'play').length;

  // Closing type: graceful if any state reached CLOSING, else user_stopped
  const closingType = state.some(s => s.to === 'CLOSING')
    ? 'graceful' : 'user_stopped';

  return {
    aetheria_export_version: '1.0',
    export_type: 'session_summary_for_tagger',
    exported_at: new Date().toISOString(),

    // metadata block for compatibility with the Session Tagger's validation
    metadata: {
      sessionId: metadata.sessionId,
      userId: metadata.userId,
      startTime: metadata.startTime,
      endTime: metadata.endTime,
      softwareVersion: metadata.softwareVersion
    },

    session: {
      sessionId: metadata.sessionId,
      startTime: metadata.startTime,
      endTime: metadata.endTime,
      duration_seconds: durationSeconds,
      softwareVersion: metadata.softwareVersion
    },

    summary: {
      peak_tcs: +peakTcs.toFixed(1),
      mean_tcs: +meanTcs.toFixed(1),
      peak_bcs: hasBcs ? +peakBcs.toFixed(1) : null,
      mean_bcs: hasBcs ? +meanBcs.toFixed(1) : null,
      phase_transition_detected: phaseTransitionDetected,
      phase_transition_time_seconds: phaseTransitionTimeSeconds,
      harm_one_count: harmOneCount,
      harm_mean: +harmMean.toFixed(3),
      cascade_flips: cascadeFlips,
      prescriptions_count: prescriptionsCount,
      closing_type: closingType
    },

    time_series: {
      coherence_t: coherence.map(c => c.t),
      coherence_tcs: coherence.map(c => c.tcs),
      coherence_gut: coherence.map(c => c.gut),
      coherence_heart: coherence.map(c => c.heart),
      coherence_head: coherence.map(c => c.head),
      coherence_plv: coherence.map(c => c.plv),
      coherence_harm: coherence.map(c => c.harm),
      bcs_t: bcs.map(b => b.t),
      bcs_value: bcs.map(b => b.bcs),
      bcs_kuramoto: bcs.map(b => b.kuramoto),
      bcs_shared_energy: bcs.map(b => b.sharedEnergy),
      bcs_mutual_info: bcs.map(b => b.mutualInfo),
      bcs_phase_transition: bcs.map(b => b.phaseTransition)
    },

    state_transitions: state.map(s => ({ ...s })),
    prescriptions: prescription.map(p => ({ ...p }))
  };
}
