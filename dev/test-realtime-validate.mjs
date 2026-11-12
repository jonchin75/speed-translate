import test from "node:test";
import assert from "node:assert/strict";
import { validateRealtimeRequest } from "../functions/realtime.ts";

process.env.DASHSCOPE_API_KEY = "sk-sp-test.fake.key-1234567890";

function request(query = "action=realtime&target=es", headers = {}) {
  return new Request(`http://127.0.0.1:4173/functions/v1/app?${query}`, {
    method: "GET",
    headers: {
      origin: "http://127.0.0.1:4173",
      "x-forwarded-host": "127.0.0.1:4173",
      ...headers,
    },
  });
}

test("valid upgrade request passes", () => {
  assert.equal(validateRealtimeRequest(request()), null);
});

test("a foreign origin is rejected", () => {
  const error = validateRealtimeRequest(request(undefined, { origin: "https://evil.example" }));
  assert.equal(error.status, 403);
  assert.equal(error.code, "forbidden_origin");
});

test("an unsupported target is rejected", () => {
  const error = validateRealtimeRequest(request("action=realtime&target=xx"));
  assert.equal(error.status, 400);
  assert.equal(error.code, "invalid_target");
});

test("a non-GET method is rejected", () => {
  const req = request();
  const post = new Request(req.url, { method: "POST", headers: req.headers });
  const error = validateRealtimeRequest(post);
  assert.equal(error.status, 405);
  assert.equal(error.code, "method_not_allowed");
});

test("a missing key is reported when no cookie or env key exists", () => {
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  const error = validateRealtimeRequest(request());
  process.env.DASHSCOPE_API_KEY = saved;
  assert.equal(error.status, 503);
  assert.equal(error.code, "service_not_configured");
});

test("prototype keys are rejected as an unsupported target", () => {
  for (const target of ["constructor", "__proto__"]) {
    const error = validateRealtimeRequest(request(`action=realtime&target=${target}`));
    assert.equal(error.status, 400, target);
    assert.equal(error.code, "invalid_target", target);
  }
});

test("a missing origin header is rejected", () => {
  const req = request(undefined, { origin: "" });
  assert.equal((req.headers.get("origin") ?? "").trim(), "");
  const error = validateRealtimeRequest(req);
  assert.equal(error.status, 403);
  assert.equal(error.code, "forbidden_origin");
});

test("a key from the st_key cookie passes validation", () => {
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    const error = validateRealtimeRequest(request(undefined, { cookie: "st_key=sk-sp-cookie.fake.key-1234567890" }));
    assert.equal(error, null);
  } finally {
    if (saved === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = saved;
  }
});

test("the public site origin passes behind an internal proxy host", () => {
  const req = new Request("http://22.0.210.121:9998/app?action=realtime&target=es", {
    method: "GET",
    headers: {
      origin: "https://speech-translator-es3ao1wi40x.qoder.website",
      host: "22.0.210.121:9998",
      "x-forwarded-host": "22.0.210.121:9998",
    },
  });
  assert.equal(validateRealtimeRequest(req), null);
});

test("a forwarded public host is accepted when Host is internal", () => {
  const req = new Request("http://10.0.0.5:9998/app?action=realtime&target=es", {
    method: "GET",
    headers: {
      origin: "https://preview.example.qoder.website",
      host: "10.0.0.5:9998",
      "x-forwarded-host": "preview.example.qoder.website",
    },
  });
  assert.equal(validateRealtimeRequest(req), null);
});

test("a foreign origin is rejected behind an internal proxy host", () => {
  const req = new Request("http://22.0.210.121:9998/app?action=realtime&target=es", {
    method: "GET",
    headers: {
      origin: "https://evil.example",
      host: "22.0.210.121:9998",
      "x-forwarded-host": "22.0.210.121:9998",
    },
  });
  const error = validateRealtimeRequest(req);
  assert.equal(error.status, 403);
  assert.equal(error.code, "forbidden_origin");
});
