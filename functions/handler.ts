const GATEWAY = "https://token-plan.ap-southeast-1.maas.aliyuncs.com";
const ASR_MODEL = "qwen-audio-3.0-asr-flash";
const LLM_MODEL = "qwen3.7-plus";
const TTS_MODEL = "qwen-audio-3.0-tts-plus";
const TTS_VOICE = "longanlingxin";
import {
  KEY_COOKIE,
  KEY_COOKIE_PATH,
  KEY_PATTERN,
  LANGUAGES,
  RequestError,
  apiKey,
  fail,
  json,
  keyFamily,
  keyState,
} from "./shared.ts";
import { handleRealtimeUpgrade } from "./realtime.ts";

const KEY_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_WAV_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_SPEECH_CHARS = 2000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TIMEOUT_ASR_MS = 60_000;
const TIMEOUT_TRANSLATE_MS = 30_000;
const TIMEOUT_TTS_MS = 60_000;
const TIMEOUT_DOWNLOAD_MS = 30_000;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestError(413, "body_too_large", "The recording is too large. Keep it under two minutes.");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new RequestError(415, "unsupported_media_type", "Send the request as JSON.");
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new RequestError(413, "body_too_large", "The recording is too large. Keep it under two minutes.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new RequestError(400, "invalid_json", "The request body was not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "invalid_body", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function requireText(value: unknown, limit: number, field: string): string {
  if (typeof value !== "string") {
    throw new RequestError(400, "invalid_input", `The ${field} field is required.`);
  }
  const text = value.trim();
  if (!text) {
    throw new RequestError(400, "invalid_input", `The ${field} field is empty.`);
  }
  if (text.length > limit) {
    throw new RequestError(400, "invalid_input", `The ${field} field is too long.`);
  }
  return text;
}

function requireTarget(value: unknown): string {
  if (typeof value !== "string" || !Object.hasOwn(LANGUAGES, value)) {
    throw new RequestError(400, "invalid_target", "The selected target language is not supported.");
  }
  return value;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + chunk)));
  }
  return btoa(binary);
}

function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value) {
    throw new RequestError(400, "invalid_input", "The recorded audio is missing.");
  }
  const payload = value.startsWith("data:") && value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  if (payload.length > Math.ceil(MAX_WAV_BYTES * 4 / 3) + 16) {
    throw new RequestError(413, "body_too_large", "The recording is too large. Keep it under two minutes.");
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(payload);
  } catch {
    throw new RequestError(400, "invalid_audio", "The recorded audio could not be decoded.");
  }
  if (bytes.length < 44) {
    throw new RequestError(400, "invalid_audio", "The recorded audio is not a valid WAV file.");
  }
  if (bytes.length > MAX_WAV_BYTES) {
    throw new RequestError(413, "body_too_large", "The recording is too large. Keep it under two minutes.");
  }
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  if (!header.startsWith("RIFF") || header.slice(8, 12) !== "WAVE") {
    throw new RequestError(400, "invalid_audio", "The recorded audio is not a valid WAV file.");
  }
  return bytes;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).join("");
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return flattenContent(record.content);
  }
  return "";
}

function asrText(body: Record<string, unknown>): string {
  const output = body.output;
  if (!output || typeof output !== "object") return "";
  const record = output as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length) {
    const choice = choices[0] as Record<string, unknown> | null;
    const message = choice && typeof choice === "object" ? choice.message : null;
    if (message && typeof message === "object") {
      return flattenContent((message as Record<string, unknown>).content).trim();
    }
  }
  return "";
}

function chatText(body: Record<string, unknown>): string {
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices.length) return "";
  const choice = choices[0] as Record<string, unknown> | null;
  const message = choice && typeof choice === "object" ? choice.message : null;
  if (!message || typeof message !== "object") return "";
  return flattenContent((message as Record<string, unknown>).content).trim();
}

async function callGateway(
  key: string,
  path: string,
  payload: unknown,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new RequestError(504, "upstream_timeout", timeoutMessage);
    }
    throw new RequestError(502, "upstream_unreachable", "The speech service could not be reached. Please try again.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new RequestError(502, "upstream_auth", "The speech service key was rejected. Please try again later.");
  }
  if (response.status === 429) {
    throw new RequestError(429, "upstream_busy", "The speech service is busy right now. Wait a few seconds and try again.");
  }
  if (response.status === 413) {
    throw new RequestError(413, "upstream_too_large", "The recording is too large. Keep it under two minutes.");
  }
  if (response.status >= 400) {
    throw new RequestError(502, "upstream_error", "The speech service returned an error. Please try again.");
  }
  return response;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RequestError(502, "upstream_error", "The speech service returned an unreadable response. Please try again.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(502, "upstream_error", "The speech service returned an unreadable response. Please try again.");
  }
  return body as Record<string, unknown>;
}

function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function cookieAttributes(request: Request, maxAge: number): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `Path=${KEY_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function handleKey(request: Request): Promise<Response> {
  const state = keyState(request);

  if (request.method === "GET" || request.method === "HEAD") {
    return json({ ok: true, ...state });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const value = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!KEY_PATTERN.test(value)) {
      throw new RequestError(400, "invalid_key", "That key format is not valid. Paste the full key and try again.");
    }
    return json(
      {
        ok: true,
        configured: true,
        source: state.source === "server" ? "server" : "browser",
        keyFamily: keyFamily(value),
      },
      200,
      { "set-cookie": `${KEY_COOKIE}=${value}; ${cookieAttributes(request, KEY_COOKIE_MAX_AGE)}` },
    );
  }

  if (request.method === "DELETE") {
    return json(
      {
        ok: true,
        configured: state.source === "server",
        source: state.source === "server" ? "server" : "none",
        keyFamily: state.source === "server" ? state.keyFamily : "other",
      },
      200,
      { "set-cookie": `${KEY_COOKIE}=; ${cookieAttributes(request, 0)}` },
    );
  }

  throw new RequestError(405, "method_not_allowed", "This route accepts GET, POST or DELETE.");
}

async function handleAsr(request: Request): Promise<Response> {
  const body = await readJson(request);
  const audio = decodeAudio(body.audioBase64);
  const key = apiKey(request);
  const started = performance.now();

  const response = await callGateway(
    key,
    "/api/v1/services/aigc/multimodal-generation/generation",
    {
      model: ASR_MODEL,
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: `data:audio/wav;base64,${bytesToBase64(audio)}` },
              },
            ],
          },
        ],
      },
      parameters: { format: "wav", sample_rate: 16_000 },
    },
    TIMEOUT_ASR_MS,
    "Speech recognition took too long. Try a shorter recording.",
  );

  const text = asrText(await parseJsonResponse(response));
  if (!text) {
    throw new RequestError(422, "no_speech", "No speech was recognized. Record a clearer, longer phrase.");
  }
  return json({ ok: true, text, ms: Math.round(performance.now() - started), model: ASR_MODEL });
}

async function handleTranslate(request: Request): Promise<Response> {
  const body = await readJson(request);
  const text = requireText(body.text, MAX_TEXT_CHARS, "text");
  const target = requireTarget(body.target);
  const key = apiKey(request);
  const started = performance.now();

  const systemPrompt =
    "You are a professional, high-accuracy translator. Translate the " +
    `provided user text directly into ${LANGUAGES[target]}. Output ONLY the ` +
    "final translated text. Do not include notes, preambles, " +
    "explanations, or quotes.";

  const response = await callGateway(
    key,
    "/compatible-mode/v1/chat/completions",
    {
      model: LLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      enable_thinking: false,
    },
    TIMEOUT_TRANSLATE_MS,
    "Translation took too long. Shorten the recording and try again.",
  );

  const translation = chatText(await parseJsonResponse(response));
  if (!translation) {
    throw new RequestError(422, "empty_translation", "The translation came back empty. Please try again.");
  }
  return json({
    ok: true,
    text: translation,
    ms: Math.round(performance.now() - started),
    model: LLM_MODEL,
  });
}

async function downloadAudio(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "audio/*" },
      signal: AbortSignal.timeout(TIMEOUT_DOWNLOAD_MS),
    });
  } catch {
    throw new RequestError(502, "tts_download", "The generated speech could not be downloaded. Please try again.");
  }
  if (!response.ok) {
    throw new RequestError(502, "tts_download", "The generated speech could not be downloaded. Please try again.");
  }

  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) {
    throw new RequestError(502, "tts_download", "The generated speech was unexpectedly large. Please try again.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
    throw new RequestError(502, "tts_download", "The generated speech could not be downloaded. Please try again.");
  }
  const mime = (response.headers.get("content-type") ?? "audio/mpeg").split(";")[0].trim() || "audio/mpeg";
  return { bytes, mime: mime.startsWith("audio/") ? mime : "audio/mpeg" };
}

async function handleTts(request: Request): Promise<Response> {
  const body = await readJson(request);
  const text = requireText(body.text, MAX_SPEECH_CHARS, "text");
  requireTarget(body.target);
  const key = apiKey(request);
  const started = performance.now();

  const response = await callGateway(
    key,
    "/api/v1/services/audio/tts/SpeechSynthesizer",
    {
      model: TTS_MODEL,
      input: { text, voice: TTS_VOICE, format: "mp3", sample_rate: 24_000 },
    },
    TIMEOUT_TTS_MS,
    "Speech generation took too long. Try a shorter phrase.",
  );

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  let audio: { bytes: Uint8Array; mime: string };

  if (!contentType.includes("json")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
      throw new RequestError(502, "tts_empty", "Speech synthesis returned no audio. Please try again.");
    }
    audio = { bytes, mime: contentType.startsWith("audio/") ? contentType.split(";")[0] : "audio/mpeg" };
  } else {
    const payload = await parseJsonResponse(response);
    const output = payload.output && typeof payload.output === "object" ? payload.output as Record<string, unknown> : {};
    const info = output.audio && typeof output.audio === "object" ? output.audio as Record<string, unknown> : {};
    const url = info.url;
    const data = info.data;

    if (typeof url === "string" && url) {
      audio = await downloadAudio(url);
    } else if (typeof data === "string" && data) {
      const payloadBase64 = data.startsWith("data:") && data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(payloadBase64);
      } catch {
        throw new RequestError(502, "tts_empty", "The generated speech could not be decoded. Please try again.");
      }
      if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
        throw new RequestError(502, "tts_empty", "Speech synthesis returned no audio. Please try again.");
      }
      audio = { bytes, mime: "audio/mpeg" };
    } else {
      throw new RequestError(502, "tts_empty", "Speech synthesis returned no audio. Please try again.");
    }
  }

  return json({
    ok: true,
    audioBase64: bytesToBase64(audio.bytes),
    mime: audio.mime,
    ms: Math.round(performance.now() - started),
    model: TTS_MODEL,
    voice: TTS_VOICE,
  });
}

export async function handler(request: Request): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (new URL(request.url).searchParams.get("action") !== "realtime") {
      return fail(404, "not_found", "This route does not exist.");
    }
    try {
      return await handleRealtimeUpgrade(request);
    } catch (error) {
      if (error instanceof RequestError) {
        return fail(error.status, error.code, error.message);
      }
      return fail(500, "internal_error", "The live interpreter could not start.");
    }
  }

  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const route = segments.length ? segments[segments.length - 1] : "";

  try {
    if (route === "" || route === "app" || route === "health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new RequestError(405, "method_not_allowed", "This route only accepts GET.");
      }
      const state = keyState(request);
      return json({ ok: true, service: "speech-translator", configured: state.configured, source: state.source });
    }

    if (route === "key") return await handleKey(request);

    if (route !== "asr" && route !== "translate" && route !== "tts") {
      throw new RequestError(404, "not_found", "This route does not exist.");
    }
    if (request.method !== "POST") {
      throw new RequestError(405, "method_not_allowed", "This route only accepts POST.");
    }

    if (route === "asr") return await handleAsr(request);
    if (route === "translate") return await handleTranslate(request);
    return await handleTts(request);
  } catch (error) {
    if (error instanceof RequestError) {
      return fail(error.status, error.code, error.message);
    }
    return fail(500, "internal_error", "Something went wrong while processing the request. Please try again.");
  }
}
