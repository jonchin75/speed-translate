import test from "node:test";
import assert from "node:assert/strict";
import {
  initialMapState,
  mapUpstreamEvent,
  REALTIME_MODEL,
  REALTIME_VOICE,
} from "../functions/realtime-map.ts";

test("session.created sends a fixed session.update with manual turns and target instructions", () => {
  const state = initialMapState("es", 0);
  const result = mapUpstreamEvent({ type: "session.created" }, state, 0);
  assert.equal(result.client.length, 0);
  assert.equal(result.upstream.type, "session.update");
  assert.equal(result.upstream.session.voice, REALTIME_VOICE);
  assert.equal(result.upstream.session.turn_detection, null);
  assert.deepEqual(result.upstream.session.modalities, ["audio", "text"]);
  assert.match(result.upstream.session.instructions, /Spanish/);
});

test("session.updated announces readiness and listening", () => {
  let state = initialMapState("es", 0);
  state = mapUpstreamEvent({ type: "session.created" }, state, 0).state;
  const result = mapUpstreamEvent({ type: "session.updated" }, state, 50);
  assert.deepEqual(result.client[0].value, {
    type: "ready",
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
  });
  assert.deepEqual(result.client[1].value, { type: "state", value: "listening" });
  assert.equal(result.state.phase, "listening");
});

test("response start, transcript and audio produce caption, binary audio and timings", () => {
  let state = initialMapState("es", 0);
  state = mapUpstreamEvent({ type: "session.updated" }, state, 0).state;

  const created = mapUpstreamEvent({ type: "response.created" }, state, 1000);
  assert.equal(created.client[0].value.value, "thinking");
  state = created.state;
  assert.equal(state.stopAt, 1000);
  assert.equal(state.responding, true);

  const caption = mapUpstreamEvent({ type: "response.audio_transcript.delta", delta: "Hola" }, state, 1100);
  assert.deepEqual(caption.client[0].value, { type: "caption", delta: "Hola" });
  state = caption.state;
  assert.equal(state.turnText, "Hola");

  const audio = mapUpstreamEvent({ type: "response.audio.delta", delta: "AQID" }, state, 1500);
  assert.equal(audio.client[0].value.value, "speaking");
  assert.equal(audio.client[1].kind, "binary");
  assert.deepEqual([...audio.client[1].bytes], [1, 2, 3]);
  assert.equal(audio.state.firstAudioMs, 500);

  const done = mapUpstreamEvent({ type: "response.done" }, audio.state, 2000);
  assert.deepEqual(done.client[0].value, {
    type: "turn",
    text: "Hola",
    firstAudioMs: 500,
    turnMs: 1000,
  });
  assert.deepEqual(done.client[1].value, { type: "state", value: "listening" });
  assert.equal(done.state.turnText, "");
  assert.equal(done.state.stopAt, null);
  assert.equal(done.state.responding, false);
});

test("a completed transcript fills the caption when no deltas arrived", () => {
  let state = initialMapState("es", 0);
  state = mapUpstreamEvent({ type: "session.updated" }, state, 0).state;
  state = mapUpstreamEvent({ type: "response.created" }, state, 1000).state;

  const completed = mapUpstreamEvent(
    { type: "response.audio_transcript.done", transcript: "Hola, esto es una prueba." },
    state,
    1500,
  );
  assert.deepEqual(completed.client[0].value, {
    type: "caption",
    delta: "Hola, esto es una prueba.",
  });
  assert.equal(completed.state.turnText, "Hola, esto es una prueba.");

  const turn = mapUpstreamEvent({ type: "response.done" }, completed.state, 2000);
  assert.equal(turn.client[0].value.text, "Hola, esto es una prueba.");
});

test("a completed transcript does not duplicate streamed deltas", () => {
  let state = initialMapState("es", 0);
  state = mapUpstreamEvent({ type: "session.updated" }, state, 0).state;
  state = mapUpstreamEvent({ type: "response.audio_transcript.delta", delta: "Hola" }, state, 100).state;

  const completed = mapUpstreamEvent(
    { type: "response.audio_transcript.done", transcript: "Hola" },
    state,
    200,
  );
  assert.equal(completed.client.length, 0);
  assert.equal(completed.state.turnText, "Hola");
});

test("upstream error is sanitized, fatal and closes the relay", () => {
  const state = initialMapState("es", 0);
  const result = mapUpstreamEvent(
    { type: "error", message: "bad session" },
    state,
    10,
  );
  assert.equal(result.client[0].value.type, "error");
  assert.equal(result.client[0].value.code, "upstream_error");
  assert.equal(
    result.client[0].value.message,
    "The live interpreter reported an error. Please start again.",
  );
  assert.equal(result.client[0].value.fatal, true);
  assert.deepEqual(result.close, { code: 1011, reason: "upstream_error" });
  assert.doesNotMatch(JSON.stringify(result.client), /bad session/);
});

test("unknown events are ignored", () => {
  const state = initialMapState("es", 0);
  const result = mapUpstreamEvent({ type: "response.output_item.added" }, state, 10);
  assert.equal(result.client.length, 0);
  assert.equal(result.upstream, undefined);
  assert.equal(result.close, undefined);
});

test("unknown target falls back to Spanish instead of a prototype key", () => {
  const state = initialMapState("constructor", 0);
  const result = mapUpstreamEvent({ type: "session.created" }, state, 0);
  assert.match(result.upstream.session.instructions, /Spanish/);
  assert.doesNotMatch(result.upstream.session.instructions, /native code/);
});
