import test from "node:test";
import assert from "node:assert/strict";
import { keyFamily } from "../functions/shared.ts";

test("a workspace key is recognized", () => {
  assert.equal(keyFamily("sk-ws-abcdef123456"), "workspace");
});

test("a Token Plan key is recognized", () => {
  assert.equal(keyFamily("sk-sp-abcdef123456"), "token_plan");
});

test("any other value is left as unknown", () => {
  assert.equal(keyFamily("sk-other"), "other");
  assert.equal(keyFamily(""), "other");
});
