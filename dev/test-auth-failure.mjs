import test from "node:test";
import assert from "node:assert/strict";
import { authFailureView } from "../web/auth-failure.js";

test("a rejected browser key asks the user to open Settings", () => {
  const view = authFailureView("browser");
  assert.match(view.message, /Open Settings/);
  assert.equal(view.openSettings, true);
});

test("a rejected site key asks the user to contact the owner", () => {
  const view = authFailureView("server");
  assert.match(view.message, /site owner/);
  assert.equal(view.openSettings, false);
});

test("an unknown key source falls back to the browser instructions", () => {
  const view = authFailureView("unknown");
  assert.equal(view.openSettings, true);
});

test("a second rejection keeps Settings closed but still explains the fix", () => {
  const view = authFailureView("browser", { prompted: true });
  assert.match(view.message, /Open Settings/);
  assert.equal(view.openSettings, false);
});

test("a stored Token Plan key is named as the cause", () => {
  const view = authFailureView("browser", { keyFamily: "token_plan" });
  assert.match(view.message, /Token Plan/);
  assert.match(view.message, /sk-ws-/);
  assert.equal(view.openSettings, true);
});

test("a named Token Plan key does not reopen Settings after the first prompt", () => {
  const view = authFailureView("browser", { prompted: true, keyFamily: "token_plan" });
  assert.equal(view.openSettings, false);
});

test("a rejected workspace key points at the key itself", () => {
  const view = authFailureView("browser", { keyFamily: "workspace" });
  assert.match(view.message, /workspace key/);
  assert.match(view.message, /inactive|revoked|another workspace/);
  assert.equal(view.openSettings, true);
});
