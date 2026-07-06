import assert from "node:assert/strict";
import test from "node:test";

import { extractSessionId, sessionSocketName } from "../src/session-hook.mjs";

test("extracts session id from payload before inherited environment", () => {
  assert.equal(extractSessionId({ session_id: "payload" }, { CODEX_SESSION_ID: "env" }), "payload");
});

test("extracts session id from common hook payload shapes", () => {
  assert.equal(extractSessionId({ session_id: "a" }, {}), "a");
  assert.equal(extractSessionId({ sessionId: "b" }, {}), "b");
  assert.equal(extractSessionId({ "x-codex-turn-metadata": { session_id: "c" } }, {}), "c");
  assert.equal(extractSessionId({ metadata: { sessionId: "d" } }, {}), "d");
  assert.equal(extractSessionId({ session: { id: "e" } }, {}), "e");
});

test("returns null when no session id is present", () => {
  assert.equal(extractSessionId({ event: "SessionStart" }, {}), null);
});

test("builds a safe socket name", () => {
  assert.equal(sessionSocketName("abc/def ghi"), "codex-iab-abc-def-ghi.sock");
});
