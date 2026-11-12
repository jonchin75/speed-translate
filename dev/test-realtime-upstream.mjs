import test from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamFailure } from "../functions/realtime.ts";

test("a 401 from the gateway is reported as an auth rejection", () => {
  const reason = classifyUpstreamFailure([
    "Error: fetch upgrade status 401",
    "Error: raw status HTTP/1.1 401 Unauthorized",
  ]);
  assert.equal(reason, "upstream_auth");
});

test("a 403 from the gateway is reported as an auth rejection", () => {
  assert.equal(classifyUpstreamFailure(["Error: fetch upgrade status 403"]), "upstream_auth");
});

test("transport failures stay a generic outage", () => {
  assert.equal(
    classifyUpstreamFailure([
      "SyntaxError: Invalid protocol value.",
      "Error: fetch upgrade status 500",
      "Error: raw handshake timeout",
    ]),
    "upstream_unavailable",
  );
});

test("no attempts recorded is a generic outage", () => {
  assert.equal(classifyUpstreamFailure([]), "upstream_unavailable");
});

test("auth text elsewhere is not mistaken for a status code", () => {
  assert.equal(classifyUpstreamFailure(["Error: upstream 1401 timeout"]), "upstream_unavailable");
});
