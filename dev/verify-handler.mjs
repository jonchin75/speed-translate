import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { handler } from "../functions/handler.ts";

const SECRETS = resolve(import.meta.dirname, "..", "..", "speech-translator", ".streamlit", "secrets.toml");
const SAMPLE = process.env.SAMPLE_WAV || "/tmp/asr_sample.wav";
const ORIGIN = "http://127.0.0.1:4173";

async function loadKey() {
  const text = await readFile(SECRETS, "utf8");
  const match = text.match(/^\s*DASHSCOPE_API_KEY\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("No DASHSCOPE_API_KEY found in the local secrets file.");
  process.env.DASHSCOPE_API_KEY = match[1];
  return match[1];
}

function call(path, init) {
  return handler(new Request(`${ORIGIN}/functions/v1/app${path}`, init));
}

function postJson(path, payload, headers = {}) {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

async function expect(label, condition, detail = "") {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok   ${label}`);
}

async function pipeline(label, headers) {
  console.log(`Pipeline (${label})`);
  const wav = await readFile(SAMPLE);
  const asrResponse = await postJson("/asr", { audioBase64: wav.toString("base64") }, headers);
  const asr = await asrResponse.json();
  await expect("ASR returns text", asrResponse.status === 200 && asr.ok === true && asr.text.length > 0, JSON.stringify(asr));
  console.log(`       transcript: ${asr.text} (${asr.ms} ms)`);

  const translateResponse = await postJson("/translate", { text: asr.text, target: "es" }, headers);
  const translation = await translateResponse.json();
  await expect("Translate returns text", translateResponse.status === 200 && translation.ok === true && translation.text.length > 0, JSON.stringify(translation));
  console.log(`       translation: ${translation.text} (${translation.ms} ms)`);

  const ttsResponse = await postJson("/tts", { text: translation.text, target: "es" }, headers);
  const tts = await ttsResponse.json();
  await expect("TTS returns audio", ttsResponse.status === 200 && tts.ok === true && tts.audioBase64.length > 1000, JSON.stringify({ ok: tts.ok, code: tts.code }));
  const audio = Buffer.from(tts.audioBase64, "base64");
  await writeFile("/tmp/handler-tts.mp3", audio);
  console.log(`       audio: ${audio.length} bytes, ${tts.mime}, voice ${tts.voice} (${tts.ms} ms)`);
  console.log(`       total: ${asr.ms + translation.ms + tts.ms} ms`);
}

const key = await loadKey();

console.log("Health (server key)");
const health = await call("", { method: "GET" });
const healthBody = await health.json();
await expect("GET / returns ok", health.status === 200 && healthBody.ok === true, JSON.stringify(healthBody));
await expect("server key reported", healthBody.configured === true && healthBody.source === "server");
await expect("health does not leak the key", !JSON.stringify(healthBody).includes(key));

console.log("Guards");
const wrongMethod = await call("/asr", { method: "GET" });
await expect("GET /asr rejected", wrongMethod.status === 405);
const badTarget = await postJson("/translate", { text: "hello", target: "xx" });
await expect("unknown target rejected", badTarget.status === 400);
const badAudio = await postJson("/asr", { audioBase64: "bm90IGEgd2F2" });
await expect("non-WAV audio rejected", badAudio.status === 400);
const emptyText = await postJson("/translate", { text: "   ", target: "es" });
await expect("empty text rejected", emptyText.status === 400);
const unknownRoute = await call("/debug", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
await expect("unknown route 404", unknownRoute.status === 404);

await pipeline("server key", {});

console.log("Cookie key flow");
delete process.env.DASHSCOPE_API_KEY;
const none = await (await call("/key", { method: "GET" })).json();
await expect("starts unconfigured", none.ok === true && none.source === "none" && none.configured === false);
const missing = await postJson("/translate", { text: "hello", target: "es" });
await expect("request without key is rejected", missing.status === 503);
const badKey = await postJson("/key", { apiKey: "short" });
await expect("invalid key format rejected", badKey.status === 400);

const save = await postJson("/key", { apiKey: key });
const saveBody = await save.json();
const cookie = (save.headers.get("set-cookie") || "").split(";")[0];
await expect("key saved", save.status === 200 && saveBody.ok === true && saveBody.source === "browser", JSON.stringify(saveBody));
await expect("cookie is HttpOnly and Strict", /HttpOnly/i.test(save.headers.get("set-cookie") || "") && /SameSite=Strict/i.test(save.headers.get("set-cookie") || ""));
await expect("response body does not echo the key", !JSON.stringify(saveBody).includes(key));

const cookieHeaders = { cookie };
const cookieState = await (await call("/key", { method: "GET", headers: cookieHeaders })).json();
await expect("cookie key reported", cookieState.source === "browser" && cookieState.configured === true);

await pipeline("cookie key", cookieHeaders);

const cleared = await call("/key", { method: "DELETE", headers: cookieHeaders });
const clearedBody = await cleared.json();
await expect("key forgotten", cleared.status === 200 && clearedBody.source === "none" && /Max-Age=0/i.test(cleared.headers.get("set-cookie") || ""));
const clearedState = await (await call("/key", { method: "GET" })).json();
await expect("cookie cleared", clearedState.source === "none");

process.env.DASHSCOPE_API_KEY = key;
console.log("\nAll handler checks passed.");
