export const SILENT_PEAK = 300;
export const SILENCE_KEEP_AHEAD = 0.35;
export const LEAD_TRIM_MAX_MS = 1500;
export const CATCHUP_QUEUE = 0.6;
// Continuous translation yields about 1.3 s of audio per second of speech, so
// the cap must stay above that ratio or the queue can never drain.
export const MAX_RATE = 1.4;

export function decidePlayback({ awaitingAudio, peak, skippedLeadMs, queuedS }) {
  if (awaitingAudio && peak < SILENT_PEAK && skippedLeadMs < LEAD_TRIM_MAX_MS) {
    return { action: "skip_lead", awaitingAudio: true, rate: null };
  }
  if (peak < SILENT_PEAK && queuedS > SILENCE_KEEP_AHEAD) {
    return { action: "skip_silence", awaitingAudio: false, rate: null };
  }
  const rate = queuedS <= CATCHUP_QUEUE
    ? null
    : Math.min(MAX_RATE, 1 + (queuedS - CATCHUP_QUEUE) * 0.12);
  return { action: "play", awaitingAudio: false, rate };
}
