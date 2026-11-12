import { decidePlayback } from "./playback-policy.js";
import { authFailureView } from "./auth-failure.js";
import { initSettings } from "./settings.js";

const LANGUAGES = {
  en: "English",
  zh: "Mandarin Chinese",
  es: "Spanish",
  ja: "Japanese",
  fr: "French",
  ko: "Korean",
  de: "German",
};

const RECONNECT_DELAYS = [1000, 2000, 4000];
const OUTPUT_RATE = 24000;
const KEEPALIVE_MS = 20000;

const elements = {
  main: document.querySelector("#main"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  target: document.querySelector("#target"),
  liveBtn: document.querySelector("#liveBtn"),
  liveLabel: document.querySelector("#liveLabel"),
  hint: document.querySelector("#hint"),
  meterFill: document.querySelector("#meterFill"),
  outFill: document.querySelector("#outFill"),
  testAudioBtn: document.querySelector("#testAudioBtn"),
  error: document.querySelector("#error"),
  errorText: document.querySelector("#errorText"),
  retryBtn: document.querySelector("#retryBtn"),
  caption: document.querySelector("#caption"),
  turns: document.querySelector("#turns"),
};

const state = {
  status: "idle",
  runId: 0,
  socket: null,
  ready: false,
  everReady: false,
  stream: null,
  capture: null,
  playback: null,
  node: null,
  nextStart: 0,
  sources: new Set(),
  keepaliveId: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  keySource: "unknown",
  keyFamily: "other",
  authPrompted: false,
  target: elements.target.value,
  turnLang: LANGUAGES[elements.target.value],
  currentTurn: "",
  playbackSignaled: false,
  playbackErrorShown: false,
  awaitingAudio: false,
  thinkingAt: 0,
  skippedLeadMs: 0,
  turnAudibleMs: null,
  timingSent: false,
  turnRate: 1,
  captionAt: null,
  turnPeak: 0,
  vadActive: false,
  vadSpeechMs: 0,
  vadQuiet: 0,
};

const settings = initSettings({
  mode: "live",
  onChange(source, keyFamily) {
    state.keySource = source;
    state.keyFamily = keyFamily || "other";
    state.authPrompted = false;
    setControls();
  },
});

const VOICE_LEVEL = 0.02;
const VAD_WINDOW_MS = 300;
const VAD_MIN_SPEECH_MS = 300;
const VAD_SILENCE_WINDOWS = 2;

let outMeterTimer = null;

function flashOutput(peak) {
  const ratio = Math.min(1, Math.abs(peak) / 32768);
  const percent = Math.min(100, Math.round(Math.sqrt(ratio) * 180));
  elements.outFill.style.width = `${percent}%`;
  if (outMeterTimer !== null) window.clearTimeout(outMeterTimer);
  outMeterTimer = window.setTimeout(() => {
    elements.outFill.style.width = "0%";
    outMeterTimer = null;
  }, 250);
}

function setStatus(label, phase) {
  elements.statusText.textContent = label;
  elements.statusPill.dataset.state = phase;
  elements.main.setAttribute("aria-busy", phase === "processing" ? "true" : "false");
}

function setControls() {
  const running = state.status !== "idle";
  elements.liveBtn.disabled = state.keySource === "none" && !running;
  elements.liveBtn.dataset.active = running ? "true" : "false";
  elements.liveLabel.textContent = running ? "Stop interpreting" : "Start listening";
  elements.target.disabled = state.status === "connecting";
}

function clearError() {
  elements.error.hidden = true;
  elements.errorText.textContent = "";
  elements.retryBtn.hidden = true;
}

function showError(message, retryable) {
  elements.errorText.textContent = message;
  elements.retryBtn.hidden = !retryable;
  elements.error.hidden = false;
  setStatus("Needs attention", "error");
}

function micMessage(error) {
  if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Microphone access was blocked. Allow it in your browser's site settings, then start again.";
  }
  if (error && error.name === "NotFoundError") {
    return "No microphone was found. Connect one or choose a different input device.";
  }
  return "The microphone could not be started. Close other apps using it and try again.";
}

function trackVoice(level) {
  if (state.status !== "active" || !state.ready) return;

  if (level >= VOICE_LEVEL) {
    state.vadActive = true;
    state.vadSpeechMs += VAD_WINDOW_MS;
    state.vadQuiet = 0;
    return;
  }

  if (!state.vadActive) return;
  state.vadQuiet += 1;
  if (state.vadSpeechMs < VAD_MIN_SPEECH_MS || state.vadQuiet < VAD_SILENCE_WINDOWS) return;

  state.vadActive = false;
  state.vadSpeechMs = 0;
  state.vadQuiet = 0;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "client_commit" }));
  setStatus("Translating…", "processing");
}

async function testSpeaker() {
  clearError();
  let context = null;
  try {
    context = new AudioContext();
    await Promise.race([
      context.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (context.state !== "running") throw new Error("blocked");

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.setValueAtTime(990, now + 0.18);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.setValueAtTime(0.18, now + 0.32);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.4);
    oscillator.onended = () => context.close().catch(() => {});

    flashOutput(9000);
    window.setTimeout(() => flashOutput(9000), 190);
    elements.hint.textContent = "Test tone played. If you did not hear it, check the tab's mute and your output device.";
  } catch {
    if (context) context.close().catch(() => {});
    elements.hint.textContent = "This browser blocked the test tone. Click the page once, then try again.";
  }
}

function closeSocket() {
  const socket = state.socket;
  state.socket = null;
  state.ready = false;
  if (state.keepaliveId !== null) {
    window.clearInterval(state.keepaliveId);
    state.keepaliveId = null;
  }
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

async function start() {
  clearError();
  if (state.keySource === "none") {
    settings.open({ focus: true });
    showError("Add your service key in Settings to start the interpreter.", false);
    return;
  }

  const runId = ++state.runId;
  state.everReady = false;

  state.status = "connecting";
  setStatus("Starting…", "processing");
  setControls();

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    if (state.runId === runId) {
      state.status = "idle";
      setStatus("Idle", "idle");
      setControls();
      showError(micMessage(error), false);
    }
    return;
  }

  if (state.runId !== runId) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  state.stream = stream;

  const capture = new AudioContext();
  state.capture = capture;
  await Promise.race([
    capture.resume().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  if (state.runId === runId && capture.state !== "running") {
    if (state.capture === capture) state.capture = null;
    capture.close().catch(() => {});
    stop();
    showError("This browser blocked microphone audio. Tap Start again to allow it.", false);
    return;
  }

  try {
    await capture.audioWorklet.addModule("/pcm-worklet.js");
  } catch {
    if (state.runId !== runId) {
      stream.getTracks().forEach((track) => track.stop());
      if (state.stream === stream) state.stream = null;
      if (state.capture === capture) state.capture = null;
      capture.close().catch(() => {});
      return;
    }
    stop();
    showError("This browser could not start the audio processor. Try Chrome, Edge, or Safari.", false);
    return;
  }

  if (state.runId !== runId) {
    stream.getTracks().forEach((track) => track.stop());
    if (state.stream === stream) state.stream = null;
    if (state.capture === capture) state.capture = null;
    capture.close().catch(() => {});
    return;
  }

  const source = capture.createMediaStreamSource(stream);
  state.node = new AudioWorkletNode(capture, "pcm-16k");
  state.node.port.onmessage = ({ data }) => {
    if (!data) return;
    if (data.type === "level") {
      const percent = Math.min(100, Math.round(Math.sqrt(data.value) * 180));
      elements.meterFill.style.width = `${percent}%`;
      trackVoice(data.value);
      return;
    }
    if (data.type !== "frame") return;
    if (!state.ready || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(data.buffer);
  };
  source.connect(state.node);
  state.node.connect(capture.destination);

  const playback = new AudioContext();
  state.playback = playback;
  await Promise.race([
    playback.resume().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  if (state.runId === runId && playback.state !== "running") {
    if (state.playback === playback) state.playback = null;
    playback.close().catch(() => {});
    stop();
    showError("This browser blocked audio playback. Tap Start again to allow sound.", false);
    return;
  }

  if (state.runId !== runId) {
    if (state.playback === playback) state.playback = null;
    playback.close().catch(() => {});
    return;
  }

  state.nextStart = 0;

  connect();
}

function connect() {
  state.ready = false;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/functions/v1/app?action=realtime&target=${encodeURIComponent(state.target)}`;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  state.currentTurn = "";
  state.playbackSignaled = false;
  state.awaitingAudio = false;
  state.turnAudibleMs = null;
  state.timingSent = false;
  state.turnRate = 1;
  state.skippedLeadMs = 0;
  state.captionAt = null;
  state.turnPeak = 0;
  state.vadActive = false;
  state.vadSpeechMs = 0;
  state.vadQuiet = 0;
  state.turnLang = LANGUAGES[state.target] || state.target;
  elements.caption.textContent = "Listening… speak whenever you are ready.";

  socket.onopen = () => {
    state.status = "active";
    setStatus("Connecting…", "processing");
    setControls();
    state.keepaliveId = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "keepalive" }));
    }, KEEPALIVE_MS);
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleControl(message);
      return;
    }
    try {
      playChunk(event.data);
    } catch (error) {
      reportPlaybackError(error);
    }
  };

  socket.onclose = (event) => {
    if (state.status === "idle") return;
    if (event && event.reason === "upstream_auth") {
      reportAuthRejected();
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => {};
}

function handleControl(message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "ready") {
    state.ready = true;
    state.everReady = true;
    state.status = "active";
    state.reconnectAttempt = 0;
    state.authPrompted = false;
    setStatus("Listening…", "listening");
    elements.caption.textContent = "Listening… speak whenever you are ready.";
    return;
  }

  if (message.type === "state") {
    if (message.value === "listening") setStatus("Listening…", "listening");
    else if (message.value === "thinking") {
      state.awaitingAudio = true;
      state.thinkingAt = performance.now();
      state.skippedLeadMs = 0;
      state.turnAudibleMs = null;
      state.timingSent = false;
      state.turnRate = 1;
      state.captionAt = null;
      state.turnPeak = 0;
      setStatus("Translating…", "processing");
    } else if (message.value === "speaking") setStatus("Speaking…", "speaking");
    return;
  }

  if (message.type === "caption") {
    if (!state.currentTurn) elements.caption.textContent = "";
    if (state.captionAt === null) state.captionAt = performance.now();
    state.currentTurn += message.delta || "";
    elements.caption.textContent = state.currentTurn;
    return;
  }

  if (message.type === "turn") {
    const text = typeof message.text === "string" && message.text.trim() ? message.text.trim() : state.currentTurn.trim();
    const latency = Number.isFinite(state.turnAudibleMs) ? state.turnAudibleMs : message.firstAudioMs;
    if (text) addTurn(text, latency);
    if (state.playback) {
      try {
        state.socket?.send(JSON.stringify({
          type: "client_turn_end",
          remainingMs: Math.round((state.nextStart - state.playback.currentTime) * 1000),
        }));
      } catch {
        // socket already closed
      }
    }
    state.currentTurn = "";
    state.awaitingAudio = false;
    state.turnAudibleMs = null;
    state.captionAt = null;
    state.turnPeak = 0;
    return;
  }

  if (message.type === "error") {
    if (message.code === "upstream_auth") {
      reportAuthRejected(message.keyFamily);
      return;
    }
    const text = typeof message.message === "string" ? message.message : "The live interpreter reported an error.";
    if (message.fatal === true) {
      stop();
      showError(text, false);
      return;
    }
    showError(text, false);
  }
}

function reportAuthRejected(keyFamily = state.keyFamily) {
  const view = authFailureView(state.keySource, {
    prompted: state.authPrompted,
    keyFamily: typeof keyFamily === "string" ? keyFamily : "other",
  });
  state.authPrompted = true;
  stop();
  showError(view.message, false);
  if (view.openSettings) settings.open({ focus: true });
}

function addTurn(text, firstAudioMs) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const body = document.createElement("span");
  body.textContent = text;
  const meta = document.createElement("span");
  meta.className = "lat";
  const latency = Number.isFinite(firstAudioMs) ? ` · ${(firstAudioMs / 1000).toFixed(2)}s` : "";
  meta.textContent = `${state.turnLang}${latency}`;
  item.append(time, body, meta);
  elements.turns.prepend(item);
  while (elements.turns.children.length > 12) {
    elements.turns.lastElementChild.remove();
  }
}

function reportPlaybackError(error) {
  if (state.playbackErrorShown) return;
  state.playbackErrorShown = true;
  const detail = error && typeof error.name === "string" ? `${error.name}: ${error.message}` : String(error);
  try {
    state.socket?.send(JSON.stringify({ type: "client_error", detail: detail.slice(0, 200) }));
  } catch {
    // socket already closed
  }
  showError("The translation audio could not play in this browser. Reload the page and start again.", false);
}

function playChunk(buffer) {
  if (buffer instanceof Blob) {
    void buffer.arrayBuffer().then(playChunk);
    return;
  }
  if (!state.playback) return;
  if (!buffer || buffer.byteLength % 2) return;
  const pcm = new Int16Array(buffer);
  if (!pcm.length) return;

  let peak = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const value = Math.abs(pcm[index]);
    if (value > peak) peak = value;
  }
  if (peak > state.turnPeak) state.turnPeak = peak;

  const now = state.playback.currentTime;
  if (state.nextStart < now) state.nextStart = now + 0.02;
  const queued = state.nextStart - now;

  const decision = decidePlayback({
    awaitingAudio: state.awaitingAudio,
    peak,
    skippedLeadMs: state.skippedLeadMs,
    queuedS: queued,
  });
  state.awaitingAudio = decision.awaitingAudio;

  // Skip the quiet lead-in of each response: scheduling it would delay the
  // translated speech without carrying any content.
  if (decision.action === "skip_lead") {
    state.skippedLeadMs += (pcm.length / OUTPUT_RATE) * 1000;
    return;
  }

  // Drop silent padding once playback is ahead; never drop audible audio,
  // since the model delivers each response faster than real time.
  if (decision.action === "skip_silence") return;

  // If the previous translation is still playing, play this one slightly
  // faster so it still starts and finishes inside the delay budget. Within a
  // turn the rate only increases, so a deep queue keeps draining as it grows.
  if (decision.rate !== null) state.turnRate = Math.max(state.turnRate, decision.rate);

  flashOutput(peak);

  const audio = state.playback.createBuffer(1, pcm.length, OUTPUT_RATE);
  const channel = audio.getChannelData(0);
  for (let index = 0; index < pcm.length; index += 1) {
    channel[index] = pcm[index] / 0x8000;
  }

  const source = state.playback.createBufferSource();
  source.buffer = audio;
  source.playbackRate.value = state.turnRate;
  source.connect(state.playback.destination);
  state.sources.add(source);
  source.onended = () => state.sources.delete(source);
  const startAt = state.nextStart;
  source.start(startAt);
  state.nextStart += audio.duration / state.turnRate;

  if (!state.timingSent) {
    state.timingSent = true;
    const scheduleMs = (startAt - now) * 1000;
    state.turnAudibleMs = Math.round(performance.now() - state.thinkingAt + scheduleMs);
    const captionToAudioMs = state.captionAt === null
      ? null
      : Math.round(performance.now() + scheduleMs - state.captionAt);
    try {
      state.socket?.send(JSON.stringify({
        type: "client_timing",
        audibleMs: state.turnAudibleMs,
        queuedMs: Math.round(scheduleMs),
        skippedLeadMs: Math.round(state.skippedLeadMs),
        rate: state.turnRate,
        peak: state.turnPeak,
        captionToAudioMs,
        baseLatencyMs: state.playback.baseLatency ? Math.round(state.playback.baseLatency * 1000) : null,
        outputLatencyMs: state.playback.outputLatency ? Math.round(state.playback.outputLatency * 1000) : null,
      }));
    } catch {
      // socket already closed
    }
  }

  if (!state.playbackSignaled) {
    state.playbackSignaled = true;
    try {
      state.socket?.send(JSON.stringify({ type: "playback_started" }));
    } catch {
      // socket already closed
    }
  }
}

function stopPlayback() {
  for (const source of state.sources) {
    try {
      source.stop();
    } catch {
      // already stopped
    }
  }
  state.sources.clear();
  state.nextStart = 0;
}

function cancelReconnect() {
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (state.status === "idle") return;
  closeSocket();

  if (state.reconnectAttempt >= RECONNECT_DELAYS.length) {
    const neverReady = !state.everReady;
    stop();
    showError(
      neverReady
        ? "The service could not start. Check your service key, then try again."
        : "The live connection dropped. Start again to continue.",
      true,
    );
    return;
  }

  const delay = RECONNECT_DELAYS[state.reconnectAttempt];
  state.reconnectAttempt += 1;
  state.status = "reconnecting";
  setStatus("Reconnecting…", "processing");
  setControls();

  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (state.status !== "reconnecting") return;
    connect();
  }, delay);
}

function stop() {
  state.runId += 1;
  state.status = "idle";
  cancelReconnect();
  closeSocket();
  state.reconnectAttempt = 0;
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  if (state.capture) {
    state.capture.close().catch(() => {});
    state.capture = null;
  }
  if (state.playback) {
    stopPlayback();
    state.playback.close().catch(() => {});
    state.playback = null;
  }
  state.node = null;
  state.nextStart = 0;
  state.currentTurn = "";
  state.vadActive = false;
  state.vadSpeechMs = 0;
  state.vadQuiet = 0;
  elements.meterFill.style.width = "0%";
  elements.outFill.style.width = "0%";
  elements.caption.textContent = "Press Start, then speak.";
  setStatus("Idle", "idle");
  setControls();
}

async function toggle() {
  if (state.status === "idle") await start();
  else stop();
}

elements.liveBtn.addEventListener("click", toggle);
elements.retryBtn.addEventListener("click", () => {
  if (state.status === "idle") start();
});
elements.testAudioBtn.addEventListener("click", testSpeaker);
elements.target.addEventListener("change", () => {
  state.target = elements.target.value;
  state.turnLang = LANGUAGES[state.target] || state.target;
  if (state.status === "idle") return;
  cancelReconnect();
  closeSocket();
  state.reconnectAttempt = 0;
  state.status = "reconnecting";
  stopPlayback();
  setStatus("Switching language…", "processing");
  connect();
});

setStatus("Idle", "idle");
setControls();
