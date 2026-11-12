export const LANGUAGES: Record<string, string> = {
  en: "English",
  zh: "Mandarin Chinese",
  es: "Spanish",
  ja: "Japanese",
  fr: "French",
  ko: "Korean",
  de: "German",
};

export const KEY_COOKIE = "st_key";
export const KEY_PATTERN = /^[A-Za-z0-9._~-]{8,512}$/;
export const KEY_COOKIE_PATH = "/functions/v1/app";

export class RequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function readEnv(name: string): string {
  const deno = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno;
  if (deno?.env?.get) return deno.env.get(name) ?? "";
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] ?? "";
}

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export function fail(status: number, code: string, message: string): Response {
  return json({ ok: false, code, error: message }, status);
}

export function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

export function storedKey(request: Request): string {
  const value = readCookie(request, KEY_COOKIE);
  return KEY_PATTERN.test(value) ? value : "";
}

export function apiKey(request: Request): string {
  const envKey = readEnv("DASHSCOPE_API_KEY").trim();
  if (envKey) return envKey;
  const cookieKey = storedKey(request);
  if (cookieKey) return cookieKey;
  throw new RequestError(503, "service_not_configured", "Add your service key in the app to start translating.");
}

export function keyFamily(key: string): "workspace" | "token_plan" | "other" {
  if (key.startsWith("sk-ws-")) return "workspace";
  if (key.startsWith("sk-sp-")) return "token_plan";
  return "other";
}

export function keyState(request: Request): {
  configured: boolean;
  source: "server" | "browser" | "none";
  keyFamily?: "workspace" | "token_plan" | "other";
} {
  const envKey = readEnv("DASHSCOPE_API_KEY").trim();
  if (envKey) return { configured: true, source: "server", keyFamily: keyFamily(envKey) };
  const cookieKey = storedKey(request);
  if (cookieKey) return { configured: true, source: "browser", keyFamily: keyFamily(cookieKey) };
  return { configured: false, source: "none" };
}
