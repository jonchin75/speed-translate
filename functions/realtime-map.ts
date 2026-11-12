import { LANGUAGES } from "./shared.ts";

export const REALTIME_MODEL = "qwen-audio-3.1-realtime-flash";
export const REALTIME_VOICE = "longanqian";

export type ClientFrame =
  | { kind: "text"; value: Record<string, unknown> }
  | { kind: "binary"; bytes: Uint8Array };

export interface MapState {
  target: string;
  phase: "connecting" | "listening" | "thinking" | "speaking";
  responding: boolean;
  turnText: string;
  firstAudioMs: number | null;
  stopAt: number | null;
}

export interface MapResult {
  client: ClientFrame[];
  upstream?: Record<string, unknown>;
  close?: { code: number; reason: string };
  state: MapState;
}

export function initialMapState(target: string, _now: number): MapState {
  return {
    target,
    phase: "connecting",
    responding: false,
    turnText: "",
    firstAudioMs: null,
    stopAt: null,
  };
}

function sessionUpdate(target: string): Record<string, unknown> {
  const language = Object.hasOwn(LANGUAGES, target) ? LANGUAGES[target] : "Spanish";
  return {
    type: "session.update",
    session: {
      instructions:
        "You are a simultaneous interpreter. Translate everything you hear into " +
        `${language} and reply with ONLY the translated sentence, spoken in ${language}. ` +
        "Never answer, explain, or comment.",
      modalities: ["audio", "text"],
      voice: REALTIME_VOICE,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      // Manual turn detection: the client commits a phrase when it hears a
      // pause and then asks for a response. Both VAD modes cancel an
      // in-flight response as soon as the speaker resumes, which discarded
      // nearly every translation and left the page silent while the source
      // transcript streamed. smart_turn_v2 also drops quiet speech as
      // "ambient audio".
      turn_detection: null,
    },
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function mapUpstreamEvent(
  raw: Record<string, unknown>,
  state: MapState,
  now: number,
): MapResult {
  const next: MapState = { ...state };
  const client: ClientFrame[] = [];
  const type = typeof raw.type === "string" ? raw.type : "";

  switch (type) {
    case "session.created":
      return { client, upstream: sessionUpdate(next.target), state: next };

    case "session.updated":
      next.phase = "listening";
      client.push({ kind: "text", value: { type: "ready", model: REALTIME_MODEL, voice: REALTIME_VOICE } });
      client.push({ kind: "text", value: { type: "state", value: "listening" } });
      return { client, state: next };

    case "response.created":
      next.responding = true;
      next.phase = "thinking";
      next.stopAt = now;
      next.turnText = "";
      next.firstAudioMs = null;
      client.push({ kind: "text", value: { type: "state", value: "thinking" } });
      return { client, state: next };

    case "response.audio_transcript.delta": {
      const delta = typeof raw.delta === "string" ? raw.delta : "";
      if (!delta) return { client, state: next };
      next.turnText += delta;
      client.push({ kind: "text", value: { type: "caption", delta } });
      return { client, state: next };
    }

    case "response.audio_transcript.done": {
      // Some realtime models only emit the completed transcript, not deltas.
      if (next.turnText) return { client, state: next };
      const transcript = typeof raw.transcript === "string" ? raw.transcript.trim() : "";
      if (!transcript) return { client, state: next };
      next.turnText = transcript;
      client.push({ kind: "text", value: { type: "caption", delta: transcript } });
      return { client, state: next };
    }

    case "response.audio.delta": {
      const delta = typeof raw.delta === "string" ? raw.delta : "";
      if (!delta) return { client, state: next };
      if (next.phase !== "speaking") {
        next.phase = "speaking";
        client.push({ kind: "text", value: { type: "state", value: "speaking" } });
      }
      if (next.firstAudioMs === null) {
        next.firstAudioMs = Math.max(0, now - (next.stopAt ?? now));
      }
      client.push({ kind: "binary", bytes: base64ToBytes(delta) });
      return { client, state: next };
    }

    case "response.done": {
      next.responding = false;
      next.phase = "listening";
      client.push({
        kind: "text",
        value: {
          type: "turn",
          text: next.turnText,
          firstAudioMs: next.firstAudioMs,
          turnMs: next.stopAt === null ? null : Math.max(0, now - next.stopAt),
        },
      });
      client.push({ kind: "text", value: { type: "state", value: "listening" } });
      next.turnText = "";
      next.stopAt = null;
      next.firstAudioMs = null;
      return { client, state: next };
    }

    case "error": {
      client.push({
        kind: "text",
        value: {
          type: "error",
          code: "upstream_error",
          message: "The live interpreter reported an error. Please start again.",
          fatal: true,
        },
      });
      return { client, close: { code: 1011, reason: "upstream_error" }, state: next };
    }

    default:
      return { client, state: next };
  }
}
