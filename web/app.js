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

const MAX_SECONDS = 120;
const MIN_SECONDS = 0.4;
const SILENCE_RMS = 0.0002;
const SAMPLE_RATE = 16000;

const elements = {
  main: document.querySelector("#main"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  target: document.querySelector("#target"),
  recordBtn: document.querySelector("#recordBtn"),
  recordLabel: document.querySelector("#recordLabel"),
  stopBtn: document.querySelector("#stopBtn"),
  timer: document.querySelector("#timer"),
  hint: document.querySelector("#hint"),
  error: document.querySelector("#error"),
  errorText: document.querySelector("#errorText"),
  retryBtn: document.querySelector("#retryBtn"),
  pipeline: document.querySelector("#pipeline"),
  log: document.querySelector("#log"),
  result: document.querySelector("#result"),
  resultLang: document.querySelector("#resultLang"),
  sourceText: document.querySelector("#sourceText"),
  translationLabel: document.querySelector("#translationLabel"),
  translationText: document.querySelector("#translationText"),
  player: document.querySelector("#player"),
  latAsr: document.querySelector("#latAsr"),
  latTranslate: document.querySelector("#latTranslate"),
  latTts: document.querySelector("#latTts"),
  latTotal: document.querySelector("#latTotal"),
  meta: document.querySelector("#meta"),
  againBtn: document.querySelector("#againBtn"),
  clearBtn: document.querySelector("#clearBtn"),
};

const state = {
  recorder: null,
  stream: null,
  chunks: [],
  recording: false,
  busy: false,
  recordStart: 0,
  timerId: null,
  transcript: null,
  result: null,
  audioUrl: null,
  lastWav: null,
  lastDuration: 0,
  lastTruncated: false,
  target: elements.target.value,
  keySource: "unknown",
};

const settings = initSettings({
  onChange(source) {
    state.keySource = source;
    setControls();
  },
});

function setStatus(label, phase) {
  elements.statusText.textContent = label;
  elements.statusPill.dataset.state = phase;
  elements.main.setAttribute("aria-busy", phase === "processing" ? "true" : "false");
}

function setControls() {
  const locked = state.busy || state.recording;
  elements.recordBtn.disabled = state.busy || state.keySource === "none";
  elements.stopBtn.disabled = state.busy;
  elements.againBtn.disabled = locked;
  elements.clearBtn.disabled = locked;
  elements.target.disabled = locked;
  elements.recordBtn.hidden = state.recording;
  elements.stopBtn.hidden = !state.recording;
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

function logStep(label, ms) {
  elements.pipeline.hidden = false;
  elements.pipeline.open = true;
  const item = document.createElement("li");
  item.textContent = ms == null ? label : `${label} · ${formatMs(ms)}`;
  elements.log.append(item);
}

function resetLog() {
  elements.log.replaceChildren();
  elements.pipeline.hidden = true;
  elements.pipeline.open = false;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTimer(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  clearError();
  if (state.keySource === "none") {
    settings.open({ focus: true });
    showError("Add your service key in Settings, then start recording.", false);
    return;
  }
  if (!window.isSecureContext) {
    showError("Microphone access requires HTTPS or localhost. Open the secure site address and try again.", false);
    return;
  }
  if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
    showError("This browser cannot record audio. Try a current version of Chrome, Edge, or Safari.", false);
    return;
  }

  elements.recordBtn.disabled = true;
  elements.recordLabel.textContent = "Requesting access";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.stream = stream;
    state.recorder = recorder;
    state.chunks = [];
    state.transcript = null;
    state.result = null;
    state.lastWav = null;
    state.recording = true;
    state.busy = false;

    elements.result.hidden = true;
    resetLog();
    logStep("Listening on the browser microphone");

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) state.chunks.push(event.data);
    });
    recorder.addEventListener("stop", finishRecording, { once: true });
    recorder.start(250);

    state.recordStart = performance.now();
    elements.timer.textContent = "00:00";
    elements.hint.textContent = "Listening. Press “Stop & translate” when you finish, or wait for the 2-minute limit.";
    setStatus("Listening...", "listening");
    setControls();

    state.timerId = window.setInterval(() => {
      const elapsed = performance.now() - state.recordStart;
      elements.timer.textContent = formatTimer(elapsed);
      if (elapsed >= MAX_SECONDS * 1000) stopRecording();
    }, 200);
  } catch (error) {
    cleanupStream();
    state.recording = false;
    state.recorder = null;
    elements.recordLabel.textContent = "Start recording";
    elements.hint.textContent = "Allow microphone access when your browser asks. Recording stops automatically at 2 minutes.";
    setControls();
    if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
      showError("Microphone access was blocked. Allow it in your browser’s site settings, then try again.", false);
    } else if (error && error.name === "NotFoundError") {
      showError("No microphone was found. Connect one or choose a different input device, then try again.", false);
    } else {
      showError("The microphone could not be started. Close other apps using it and try again.", true);
    }
  }
}

function stopRecording() {
  if (!state.recording || !state.recorder) return;
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

function cleanupStream() {
  if (state.timerId != null) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
}

async function finishRecording() {
  cleanupStream();
  state.recording = false;
  state.busy = true;
  elements.recordLabel.textContent = "Start recording";
  elements.hint.textContent = "Allow microphone access when your browser asks. Recording stops automatically at 2 minutes.";
  setStatus("Processing...", "processing");
  setControls();

  const mimeType = state.recorder && state.recorder.mimeType ? state.recorder.mimeType : "audio/webm";
  const blob = new Blob(state.chunks, { type: mimeType });
  state.chunks = [];
  state.recorder = null;

  if (blob.size === 0) {
    state.busy = false;
    setControls();
    showError("The recording was empty. Hold the microphone closer and try again.", false);
    setStatus("Idle", "idle");
    return;
  }

  try {
    logStep("Normalizing audio to 16 kHz mono WAV");
    const prepared = await blobToWav(blob);
    state.lastWav = prepared.wav;
    state.lastDuration = prepared.duration;
    state.lastTruncated = prepared.truncated;
    await runPipeline(prepared);
  } catch (error) {
    state.busy = false;
    setControls();
    showError(error && error.message ? error.message : "The recording could not be processed.", Boolean(state.lastWav));
  }
}

async function blobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This browser cannot decode audio. Try a current version of Chrome, Edge, or Safari.");
  }

  const context = new AudioContextClass();
  let decoded;
  try {
    decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error("This browser could not decode the recording. Try recording again in Chrome, Edge, or Safari.");
  } finally {
    await context.close();
  }

  if (!decoded || decoded.duration < MIN_SECONDS) {
    throw new Error("That recording was too short. Speak a full phrase and try again.");
  }

  const frames = Math.max(1, Math.min(Math.ceil(decoded.duration * SAMPLE_RATE), MAX_SECONDS * SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  if (rms < SILENCE_RMS) {
    throw new Error("No speech was detected. Move closer to the microphone and try again.");
  }

  return {
    wav: encodeWav(samples, SAMPLE_RATE),
    duration: samples.length / SAMPLE_RATE,
    truncated: decoded.duration > MAX_SECONDS + 0.05,
  };
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

async function runPipeline(prepared) {
  const totalStart = performance.now();
  const timings = {};

  try {
    logStep("Recognizing speech");
    const asr = await requestJson("/asr", { audioBase64: bytesToBase64(prepared.wav) });
    timings.asr = asr.ms;
    state.transcript = asr.text;
    logStep("Recognized speech", asr.ms);
    await runTranslation(state.transcript, {
      totalStart,
      timings,
      asrCached: false,
      duration: prepared.duration,
      truncated: prepared.truncated,
    });
  } catch (error) {
    state.busy = false;
    setControls();
    showError(safeMessage(error), Boolean(state.lastWav));
  }
}

async function runTranslation(transcript, options) {
  const target = state.target;
  const totalStart = options.totalStart || performance.now();
  const timings = options.timings || {};

  state.busy = true;
  setStatus("Processing...", "processing");
  setControls();
  clearError();

  try {
    logStep(`Translating into ${LANGUAGES[target] || target}`);
    const translation = await requestJson("/translate", { text: transcript, target });
    timings.translate = translation.ms;
    logStep("Translation ready", translation.ms);

    logStep("Generating speech");
    const speech = await requestJson("/tts", { text: translation.text, target });
    timings.tts = speech.ms;
    logStep("Speech generated", speech.ms);

    const total = performance.now() - totalStart;
    timings.total = total;

    const result = {
      transcript,
      translation: translation.text,
      audioBase64: speech.audioBase64,
      mime: speech.mime,
      asrModel: translation.asrModel || speech.asrModel || "qwen-audio-3.0-asr-flash",
      llmModel: translation.model || "qwen3.7-plus",
      route: `${speech.model} / ${speech.voice}`,
      duration: options.duration,
      truncated: options.truncated,
      timings,
      asrCached: options.asrCached,
    };

    state.result = result;
    renderResult(result);
    state.busy = false;
    setControls();
    setStatus("Speaking...", "speaking");
    try {
      await elements.player.play();
    } catch {
      setStatus("Idle", "idle");
    }
  } catch (error) {
    state.busy = false;
    setControls();
    showError(safeMessage(error), Boolean(state.lastWav));
  }
}

function renderResult(result) {
  const language = LANGUAGES[state.target] || state.target;
  elements.resultLang.textContent = language;
  elements.translationLabel.textContent = `Translated · ${language}`;
  elements.sourceText.textContent = result.transcript;
  elements.translationText.textContent = result.translation;

  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  const bytes = base64ToBytes(result.audioBase64);
  state.audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime || "audio/mpeg" }));
  elements.player.src = state.audioUrl;
  elements.player.load();

  setLatency(elements.latAsr, result.timings.asr, result.asrCached);
  setLatency(elements.latTranslate, result.timings.translate, false);
  setLatency(elements.latTts, result.timings.tts, false);
  setLatency(elements.latTotal, result.timings.total, false);

  const input = `${result.duration.toFixed(1)}s input${result.truncated ? " (trimmed to 2 minutes)" : ""}`;
  elements.meta.textContent = `${input} · ${result.asrModel} → ${result.llmModel} → ${result.route}`;
  elements.result.hidden = false;
}

function setLatency(element, ms, cached) {
  const chip = element.closest(".chip");
  chip.classList.toggle("cached", Boolean(cached));
  element.textContent = cached ? "cached" : formatMs(ms);
}

function safeMessage(error) {
  if (error && typeof error.message === "string" && error.message.trim()) return error.message;
  return "Something went wrong while translating. Please try again.";
}

async function requestJson(path, payload) {
  let response;
  try {
    response = await fetch(`/functions/v1/app${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the speech service. Check your connection and try again.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error("The speech service returned an unreadable response. Please try again.");
  }

  if (!response.ok || !data || data.ok !== true) {
    if (data && data.code === "service_not_configured") {
      settings.open({ focus: true });
      throw new Error("Add your service key in Settings, then try again.");
    }
    if (data && data.code === "invalid_key") {
      settings.open({ focus: true });
      throw new Error("That key was rejected. Open Settings and save it again.");
    }
    if (response.status === 413) {
      throw new Error("The recording is too large. Keep it under two minutes.");
    }
    if (response.status === 429) {
      throw new Error("The speech service is busy right now. Wait a few seconds and try again.");
    }
    const message = data && typeof data.error === "string" ? data.error : "The speech service returned an error.";
    throw new Error(message);
  }
  return data;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function resetResult() {
  state.result = null;
  state.transcript = null;
  state.lastWav = null;
  state.lastDuration = 0;
  state.lastTruncated = false;
  elements.result.hidden = true;
  elements.player.removeAttribute("src");
  elements.player.load();
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
  }
  elements.sourceText.textContent = "";
  elements.translationText.textContent = "";
  elements.meta.textContent = "";
  setLatency(elements.latAsr, null, false);
  setLatency(elements.latTranslate, null, false);
  setLatency(elements.latTts, null, false);
  setLatency(elements.latTotal, null, false);
  resetLog();
  clearError();
  setStatus("Idle", "idle");
  setControls();
}

elements.recordBtn.addEventListener("click", startRecording);
elements.stopBtn.addEventListener("click", stopRecording);

elements.target.addEventListener("change", () => {
  state.target = elements.target.value;
  if (state.transcript && state.result && !state.busy && !state.recording) {
    runTranslation(state.transcript, {
      totalStart: performance.now(),
      timings: {},
      asrCached: true,
      duration: state.lastDuration,
      truncated: state.lastTruncated,
    });
  }
});

elements.retryBtn.addEventListener("click", () => {
  if (!state.lastWav) return;
  clearError();
  state.busy = true;
  setControls();
  setStatus("Processing...", "processing");
  runPipeline({
    wav: state.lastWav,
    duration: state.lastDuration,
    truncated: state.lastTruncated,
  });
});

elements.againBtn.addEventListener("click", () => {
  if (!state.transcript || state.busy) return;
  clearError();
  runTranslation(state.transcript, {
    totalStart: performance.now(),
    timings: {},
    asrCached: true,
    duration: state.lastDuration,
    truncated: state.lastTruncated,
  });
});

elements.clearBtn.addEventListener("click", resetResult);

elements.player.addEventListener("ended", () => {
  if (!state.busy) setStatus("Idle", "idle");
});

elements.player.addEventListener("error", () => {
  if (!state.busy) setStatus("Idle", "idle");
});

setControls();
setStatus("Idle", "idle");
