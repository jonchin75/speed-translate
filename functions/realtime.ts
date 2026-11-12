import {
  LANGUAGES,
  RequestError,
  apiKey,
  fail,
  keyFamily,
  keyState,
} from "./shared.ts";
import {
  REALTIME_MODEL,
  initialMapState,
  mapUpstreamEvent,
  type MapState,
} from "./realtime-map.ts";
import { openRawWebSocket } from "./raw-ws.ts";

const UPSTREAM = "wss://ws-zfdxfuu20cq238m5.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime";
const MAX_CLIENT_FRAME = 2 * 1024 * 1024;
const MAX_UPSTREAM_FRAME = 256 * 1024;
const MAX_SESSION_MS = 10 * 60 * 1000;
const MAX_BUFFERED = 1024 * 1024;
const HANDSHAKE_MS = 10_000;
// 375 ms of 16 kHz mono PCM16; the upstream rejects commits without audio.
const MIN_COMMIT_BYTES = 12_000;

const SITE_HOSTS = new Set(["speech-translator-es3ao1wi40x.qoder.website"]);

type WebSocketCtor = new (
  url: string,
  protocols?: string | string[] | { headers: Record<string, string> },
  options?: { headers: Record<string, string> },
) => WebSocket;

function describeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/\s+/g, " ").slice(0, 300);
}

function waitOpen(socket: WebSocket, deadlineMs: number): Promise<WebSocket> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new Error("open timeout"))), deadlineMs);
    socket.onopen = () => settle(() => resolve(socket));
    socket.onerror = () => settle(() => reject(new Error("handshake error")));
    socket.onclose = (event) => settle(() => reject(new Error(`closed ${event.code}`)));
  });
}

async function fetchUpgrade(url: string, key: string, deadlineMs: number): Promise<WebSocket> {
  const connect = Promise.resolve().then(() =>
    fetch(url.replace(/^wss:/, "https:"), {
      headers: {
        authorization: `Bearer ${key}`,
        connection: "Upgrade",
        upgrade: "websocket",
      },
    }),
  );
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("fetch upgrade timeout")), deadlineMs);
  });
  let response: Response;
  try {
    response = await Promise.race([connect, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const socket = (response as Response & { webSocket?: WebSocket & { accept?: () => void } }).webSocket;
  if (!socket) throw new Error(`fetch upgrade status ${response.status}`);
  if (typeof socket.accept === "function") {
    try {
      socket.accept();
    } catch {
      // The runtime may hand back an already accepted socket.
    }
  }
  return socket;
}

const AUTH_REJECTED = /(?:^|\D)(401|403)(?=\D|$)|unauthorized/i;

export function classifyUpstreamFailure(messages: string[]): string {
  return messages.some((message) => AUTH_REJECTED.test(message))
    ? "upstream_auth"
    : "upstream_unavailable";
}

async function connectUpstream(url: string, key: string): Promise<WebSocket> {
  const Ctor = WebSocket as unknown as WebSocketCtor;
  const headers = { authorization: `Bearer ${key}` };
  const attempts: { via: string; open: () => Promise<WebSocket> }[] = [
    { via: "constructor", open: async () => new Ctor(url, { headers }) },
    { via: "fetch", open: () => fetchUpgrade(url, key, 5000) },
    {
      via: "raw_tls",
      open: async () => (await openRawWebSocket(url, key, 5000)) as unknown as WebSocket,
    },
  ];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const socket = await attempt.open();
      await waitOpen(socket, 5000);
      console.log(JSON.stringify({ event: "realtime_upstream_connected", via: attempt.via }));
      return socket;
    } catch (error) {
      const detail = describeError(error);
      failures.push(detail);
      console.error("realtime_upstream_connect_failed", attempt.via, detail);
    }
  }
  const deno = (globalThis as { Deno?: { version?: { deno?: string }; connectTls?: unknown } }).Deno;
  console.error(
    "realtime_runtime",
    JSON.stringify({
      deno: typeof deno,
      connectTls: typeof deno?.connectTls,
      version: deno?.version?.deno ?? "",
    }),
  );
  throw new Error(classifyUpstreamFailure(failures));
}

function requestHosts(request: Request): string[] {
  const hosts = new Set<string>(SITE_HOSTS);
  const urlHost = new URL(request.url).host;
  if (urlHost) hosts.add(urlHost);
  const host = request.headers.get("host");
  if (host) hosts.add(host);
  for (const name of ["x-forwarded-host", "x-original-host"]) {
    const value = request.headers.get(name);
    if (!value) continue;
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed) hosts.add(trimmed);
    }
  }
  return [...hosts];
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin") ?? "";
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return requestHosts(request).includes(originHost);
}

export function validateRealtimeRequest(request: Request): RequestError | null {
  const url = new URL(request.url);
  if (request.method !== "GET") {
    return new RequestError(405, "method_not_allowed", "This route only accepts GET.");
  }
  if (url.searchParams.get("action") !== "realtime") {
    return new RequestError(404, "not_found", "This route does not exist.");
  }
  if (!originAllowed(request)) {
    return new RequestError(403, "forbidden_origin", "This request must come from the site.");
  }
  const target = url.searchParams.get("target") ?? "";
  if (!Object.hasOwn(LANGUAGES, target)) {
    return new RequestError(400, "invalid_target", "The selected target language is not supported.");
  }
  try {
    apiKey(request);
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  try {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
  } catch {
    // fall through
  }
  return null;
}

function boundedInt(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(max, Math.round(value)));
}

export async function handleRealtimeUpgrade(request: Request): Promise<Response> {
  console.log(JSON.stringify({
    event: "realtime_enter",
    target: new URL(request.url).searchParams.get("target"),
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    upgrade: request.headers.get("upgrade"),
    connection: request.headers.get("connection"),
    wsKey: request.headers.get("sec-websocket-key") ? "present" : "missing",
    wsVersion: request.headers.get("sec-websocket-version"),
    keySource: keyState(request).source,
    keyFamily: keyState(request).keyFamily ?? null,
  }));

  const invalid = validateRealtimeRequest(request);
  if (invalid) {
    console.log(JSON.stringify({ event: "realtime_rejected", status: invalid.status, code: invalid.code }));
    return fail(invalid.status, invalid.code, invalid.message);
  }

  const target = new URL(request.url).searchParams.get("target") ?? "es";
  const key = apiKey(request);
  let socket: WebSocket;
  let response: Response;
  try {
    ({ socket, response } = Deno.upgradeWebSocket(request));
  } catch (error) {
    console.error(
      "realtime_upgrade_failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  let upstream: WebSocket | null = null;
  let state: MapState = initialMapState(target, performance.now());
  let closed = false;
  let keepaliveTimer: number | null = null;
  let handshakeTimer: number | null = null;
  const seenEvents = new Set<string>();
  let clientAudioFrames = 0;
  let clientAudioBytes = 0;
  let upstreamAudioEvents = 0;
  let upstreamAudioBytes = 0;
  let relayAudioFrames = 0;
  let relayAudioBytes = 0;
  let turnAudioBytes = 0;
  let turnStartedAt = 0;
  let turnTextAt: number | null = null;
  let turnAudioAt: number | null = null;
  let uncommittedBytes = 0;
  let pendingResponse = false;

  const relaySummary = () => {
    console.log(
      "realtime_relay_summary",
      JSON.stringify({
        target,
        events: [...seenEvents],
        clientAudioFrames,
        clientAudioBytes,
        upstreamAudioEvents,
        upstreamAudioBytes,
        relayAudioFrames,
        relayAudioBytes,
      }),
    );
  };

  const closeAll = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    relaySummary();
    if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    try {
      upstream?.close(1000, reason);
    } catch {
      // already closed
    }
    try {
      socket.close(code, reason);
    } catch {
      // already closed
    }
  };

  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    void connectUpstream(`${UPSTREAM}?model=${REALTIME_MODEL}`, key)
      .then((upstreamSocket) => {
        if (closed) {
          try {
            upstreamSocket.close(1000, "client_closed");
          } catch {
            // already closed
          }
          return;
        }
        upstream = upstreamSocket;
        upstream.binaryType = "arraybuffer";

        handshakeTimer = setTimeout(() => closeAll(1011, "upstream_timeout"), HANDSHAKE_MS);
        keepaliveTimer = setTimeout(() => closeAll(1000, "time_limit"), MAX_SESSION_MS);

        let opened = false;
        const upstreamOpened = () => {
          if (opened) return;
          opened = true;
          console.log("realtime_upstream_open");
          if (handshakeTimer !== null) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
          }
        };
        upstream.onopen = upstreamOpened;
        if (upstream.readyState === WebSocket.OPEN) upstreamOpened();

        upstream.onmessage = (event) => {
          if (closed || typeof event.data !== "string") return;
          if (event.data.length > MAX_UPSTREAM_FRAME) {
            closeAll(1011, "upstream_frame");
            return;
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            return;
          }
          const type = typeof parsed.type === "string" ? parsed.type : "";
          if (type && !seenEvents.has(type)) {
            seenEvents.add(type);
            console.log("realtime_upstream_event", type);
          }
          if (type === "response.created") {
            turnStartedAt = performance.now();
            turnTextAt = null;
            turnAudioAt = null;
          } else if (type === "response.audio.delta") {
            const delta = typeof parsed.delta === "string" ? parsed.delta : "";
            const bytes = Math.floor((delta.length * 3) / 4);
            upstreamAudioEvents += 1;
            upstreamAudioBytes += bytes;
            turnAudioBytes += bytes;
            if (turnAudioAt === null) turnAudioAt = performance.now();
            if (upstreamAudioEvents === 1) console.log("realtime_upstream_audio_started");
          } else if (type === "response.audio_transcript.delta" && turnTextAt === null) {
            turnTextAt = performance.now();
          } else if (type === "input_audio_buffer.speech_stopped") {
            turnAudioBytes = 0;
          } else if (type === "response.done") {
            const response = parsed.response;
            const status = response && typeof response === "object" && typeof response.status === "string"
              ? response.status
              : "unknown";
            console.log(
              "realtime_turn_summary",
              JSON.stringify({
                status,
                audioMs: Math.round(turnAudioBytes / 48),
                bytes: turnAudioBytes,
                firstTextMs: turnTextAt === null ? null : Math.round(turnTextAt - turnStartedAt),
                firstAudioMs: turnAudioAt === null ? null : Math.round(turnAudioAt - turnStartedAt),
              }),
            );
            turnAudioBytes = 0;
          }
          let result;
          try {
            result = mapUpstreamEvent(parsed, state, performance.now());
          } catch {
            closeAll(1011, "upstream_payload");
            return;
          }
          state = result.state;
          if (result.upstream) upstream?.send(JSON.stringify(result.upstream));
          for (const frame of result.client) {
            if (frame.kind === "binary") {
              if (socket.bufferedAmount > MAX_BUFFERED) continue;
              relayAudioFrames += 1;
              relayAudioBytes += frame.bytes.length;
              if (relayAudioFrames === 1) console.log("realtime_relay_audio_forward_started");
              socket.send(frame.bytes);
            } else {
              socket.send(JSON.stringify(frame.value));
            }
          }
          if (type === "response.done" && pendingResponse) {
            pendingResponse = false;
            console.log("realtime_queued_response_create");
            upstream?.send(JSON.stringify({ type: "response.create" }));
          }
          if (result.close) closeAll(result.close.code, result.close.reason);
        };

        upstream.onerror = () => {
          console.error("realtime_upstream_error");
          closeAll(1011, "upstream_error");
        };
        upstream.onclose = (event) => {
          console.log(`realtime_upstream_closed ${event.code} ${event.reason}`.trim());
          closeAll(1011, "upstream_closed");
        };
      })
      .catch((error) => {
        const reason = error instanceof Error && error.message === "upstream_auth"
          ? "upstream_auth"
          : "upstream_unavailable";
        console.error("realtime_upstream_unavailable", reason, describeError(error));
        if (reason === "upstream_auth") {
          try {
            socket.send(JSON.stringify({
              type: "error",
              code: "upstream_auth",
              keyFamily: keyFamily(key),
              message: "The live service rejected the service key.",
              fatal: true,
            }));
          } catch {
            // client already gone
          }
        }
        closeAll(1011, reason);
      });
  };

  const requestTurn = () => {
    if (closed || !upstream || upstream.readyState !== WebSocket.OPEN) return;
    if (uncommittedBytes < MIN_COMMIT_BYTES) return;
    upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    console.log("realtime_client_commit", JSON.stringify({ bytes: uncommittedBytes }));
    uncommittedBytes = 0;
    if (state.responding || pendingResponse) {
      pendingResponse = true;
      return;
    }
    upstream.send(JSON.stringify({ type: "response.create" }));
  };

  const acceptClientAudio = (data: unknown) => {
    void toBytes(data).then((bytes) => {
      if (closed || !bytes || !bytes.length) return;
      if (bytes.length > MAX_CLIENT_FRAME) {
        closeAll(1009, "frame_too_large");
        return;
      }
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      clientAudioFrames += 1;
      clientAudioBytes += bytes.length;
      uncommittedBytes += bytes.length;
      if (clientAudioFrames === 1) console.log("realtime_client_audio_started");
      upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(bytes) }));
    });
  };

  socket.onmessage = (event) => {
    if (closed) return;
    if (typeof event.data === "string") {
      let message: Record<string, unknown> | null = null;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message && message.type === "keepalive") {
        socket.send(JSON.stringify({ type: "keepalive" }));
      } else if (message && message.type === "client_commit") {
        requestTurn();
      } else if (message && message.type === "playback_started") {
        console.log("realtime_client_playback_started");
      } else if (message && message.type === "client_timing") {
        const rate = typeof message.rate === "number" && Number.isFinite(message.rate)
          ? Math.min(4, Math.max(0.5, message.rate))
          : null;
        const captionToAudio = boundedInt(message.captionToAudioMs, 600_000);
        console.log(
          "realtime_client_timing",
          JSON.stringify({
            audibleMs: boundedInt(message.audibleMs, 600_000),
            queuedMs: boundedInt(message.queuedMs, 600_000),
            skippedLeadMs: boundedInt(message.skippedLeadMs, 600_000),
            captionToAudioMs: message.captionToAudioMs === null ? null : captionToAudio,
            peak: boundedInt(message.peak, 32_768),
            baseLatencyMs: boundedInt(message.baseLatencyMs, 10_000),
            outputLatencyMs: boundedInt(message.outputLatencyMs, 10_000),
            rate,
          }),
        );
      } else if (message && message.type === "client_turn_end") {
        console.log(
          "realtime_client_turn_end",
          JSON.stringify({ remainingMs: boundedInt(message.remainingMs, 600_000) }),
        );
      } else if (message && message.type === "client_error") {
        const detail = typeof message.detail === "string"
          ? message.detail.replace(/[^\x20-\x7e]/g, " ").slice(0, 200)
          : "";
        console.error("realtime_client_error_report", detail);
      }
      return;
    }
    acceptClientAudio(event.data);
  };

  socket.onclose = (event) => {
    console.log(`realtime_client_closed ${event.code} ${event.reason}`.trim());
    closeAll(1000, "client_closed");
  };
  socket.onerror = () => {
    console.error("realtime_client_error");
    closeAll(1011, "client_error");
  };

  return response;
}
