import test from "node:test";
import assert from "node:assert/strict";
import {
  decidePlayback,
  LEAD_TRIM_MAX_MS,
  MAX_RATE,
} from "../web/playback-policy.js";

const base = { awaitingAudio: true, peak: 5000, skippedLeadMs: 0, queuedS: 0.02 };

test("leading silence is skipped before the first audible chunk", () => {
  const result = decidePlayback({ ...base, peak: 120 });
  assert.equal(result.action, "skip_lead");
  assert.equal(result.awaitingAudio, true);
});

test("leading trim stops once it reaches the cap", () => {
  const result = decidePlayback({ ...base, peak: 120, skippedLeadMs: LEAD_TRIM_MAX_MS });
  assert.equal(result.action, "play");
  assert.equal(result.awaitingAudio, false);
});

test("the first audible chunk plays and clears the lead trim", () => {
  const result = decidePlayback({ ...base, peak: 5000 });
  assert.equal(result.action, "play");
  assert.equal(result.awaitingAudio, false);
  assert.equal(result.rate, null);
});

test("audible audio is never dropped, even behind a deep queue", () => {
  const result = decidePlayback({ ...base, awaitingAudio: false, peak: 5000, queuedS: 6 });
  assert.equal(result.action, "play");
});

test("interior silence is dropped only once playback runs ahead", () => {
  assert.equal(decidePlayback({ ...base, awaitingAudio: false, peak: 100, queuedS: 0.1 }).action, "play");
  assert.equal(decidePlayback({ ...base, awaitingAudio: false, peak: 100, queuedS: 0.5 }).action, "skip_silence");
});

test("a shallow queue keeps the natural rate", () => {
  assert.equal(decidePlayback({ ...base, queuedS: 0.5 }).rate, null);
});

test("catch-up starts as soon as the queue passes the budget", () => {
  const mild = decidePlayback({ ...base, queuedS: 1.0 });
  assert.ok(mild.rate > 1 && mild.rate < MAX_RATE);
});

test("a deep queue reaches the catch-up cap", () => {
  assert.equal(decidePlayback({ ...base, queuedS: 8 }).rate, MAX_RATE);
});

test("the catch-up cap outruns the model's audio expansion", () => {
  // Measured on a continuous conversation: 6.3 s of speech produced 8.24 s of
  // translated audio (ratio 1.31), so a lower cap can never drain the queue.
  assert.ok(MAX_RATE >= 1.35);
});

test("later chunks keep speeding up while the queue stays deep", () => {
  const first = decidePlayback({ ...base, queuedS: 1.5 });
  const later = decidePlayback({ ...base, queuedS: 3 });
  assert.ok(later.rate > first.rate);
  assert.ok(later.rate < MAX_RATE);
});

test("a continuous conversation drains instead of falling further behind", () => {
  // Measured: 6.3 s of speech produced 8.24 s of audio, delivered over ~2 s.
  const speechS = 6.3;
  const chunkS = 0.25;
  const count = Math.round(8.24 / chunkS);
  let nextStart = 0;
  let rate = 1;
  for (let index = 0; index < count; index += 1) {
    const arrivedAt = (index / count) * 2;
    const queued = Math.max(0, nextStart - arrivedAt);
    const decision = decidePlayback({ awaitingAudio: false, peak: 5000, skippedLeadMs: 0, queuedS: queued });
    if (decision.rate !== null) rate = Math.max(rate, decision.rate);
    nextStart += chunkS / rate;
  }
  assert.ok(nextStart < speechS + 1.5, `playback took ${nextStart.toFixed(2)} s`);
});
