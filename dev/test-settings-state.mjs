import test from "node:test";
import assert from "node:assert/strict";
import { keyIssue, settingsView, storedKeyWarning } from "../web/settings-state.js";

test("a server key is managed by the site and hides the form", () => {
  const view = settingsView("server");
  assert.equal(view.status, "Managed by this site");
  assert.equal(view.statusState, "saved");
  assert.equal(view.showForm, false);
  assert.equal(view.showForget, false);
});

test("a browser key allows replacing or forgetting it", () => {
  const view = settingsView("browser");
  assert.equal(view.status, "Saved in this browser");
  assert.equal(view.statusState, "saved");
  assert.equal(view.showForm, true);
  assert.equal(view.showForget, true);
});

test("a missing key shows the form without a forget action", () => {
  const view = settingsView("none");
  assert.equal(view.status, "Not set");
  assert.equal(view.statusState, "missing");
  assert.equal(view.showForm, true);
  assert.equal(view.showForget, false);
});

test("an unknown key state falls back to the form", () => {
  const view = settingsView("unreachable");
  assert.equal(view.status, "Status unavailable");
  assert.equal(view.statusState, "missing");
  assert.equal(view.showForm, true);
  assert.equal(view.showForget, false);
});

test("the live interpreter refuses a Token Plan key before saving", () => {
  const issue = keyIssue("sk-sp-abcdef123456", "live");
  assert.match(issue, /workspace key/);
  assert.match(issue, /sk-ws-/);
});

test("the live interpreter accepts a workspace key", () => {
  assert.equal(keyIssue("sk-ws-abcdef123456", "live"), "");
});

test("the one-shot page still accepts a Token Plan key", () => {
  assert.equal(keyIssue("sk-sp-abcdef123456", "one-shot"), "");
});

test("an unrecognized key is left to the server to validate", () => {
  assert.equal(keyIssue("not-a-key", "live"), "");
});

test("a stored Token Plan key is flagged on the live page", () => {
  assert.match(storedKeyWarning("live", "token_plan"), /Token Plan/);
});

test("a workspace key or the one-shot page shows no stored-key warning", () => {
  assert.equal(storedKeyWarning("live", "workspace"), "");
  assert.equal(storedKeyWarning("one-shot", "token_plan"), "");
});
