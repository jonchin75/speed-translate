import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { handler } from "../functions/handler.ts";
import { attachMockRealtime } from "./mock-realtime.mjs";

const ROOT = resolve(import.meta.dirname, "..", "web");
const SECRETS = resolve(import.meta.dirname, "..", "..", "speech-translator", ".streamlit", "secrets.toml");
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

async function loadKey() {
  if (process.env.SKIP_KEY_FILE === "1") return;
  if (process.env.DASHSCOPE_API_KEY) return;
  try {
    const text = await readFile(SECRETS, "utf8");
    const match = text.match(/^\s*DASHSCOPE_API_KEY\s*=\s*"([^"]+)"/m);
    if (match) process.env.DASHSCOPE_API_KEY = match[1];
  } catch {
    console.warn("No local key available; /asr, /translate and /tts will report service_not_configured.");
  }
}

function toRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

await loadKey();

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/functions/v1/app")) {
      const response = await handler(toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }

    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = normalize(join(ROOT, relative));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let target = filePath;
    try {
      await readFile(target);
    } catch {
      target = join(ROOT, "index.html");
    }
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    console.error("Preview server error:", error instanceof Error ? error.message : "unknown");
    res.writeHead(500).end("Internal Server Error");
  }
});

if (process.env.MOCK_REALTIME === "1") {
  attachMockRealtime(server);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Speech site preview: http://127.0.0.1:${PORT}/`);
});
