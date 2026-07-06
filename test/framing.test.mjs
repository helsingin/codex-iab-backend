import assert from "node:assert/strict";
import test from "node:test";

import { decodeFrames, encodeFrame } from "../src/framing.mjs";

test("encodes and decodes one framed JSON-RPC message", () => {
  const message = { jsonrpc: "2.0", id: 1, method: "ping" };
  const { messages, remaining } = decodeFrames(encodeFrame(message));
  assert.deepEqual(messages, [message]);
  assert.equal(remaining.length, 0);
});

test("keeps partial frame data for the next read", () => {
  const first = encodeFrame({ id: 1, result: "ok" });
  const second = encodeFrame({ id: 2, result: "next" });
  const combined = Buffer.concat([first, second.subarray(0, 5)]);

  const decoded = decodeFrames(combined);
  assert.deepEqual(decoded.messages, [{ id: 1, result: "ok" }]);
  assert.deepEqual(decoded.remaining, second.subarray(0, 5));
});

test("decodes multiple frames in one buffer", () => {
  const combined = Buffer.concat([
    encodeFrame({ id: 1, result: "a" }),
    encodeFrame({ id: 2, result: "b" }),
  ]);

  assert.deepEqual(decodeFrames(combined).messages, [
    { id: 1, result: "a" },
    { id: 2, result: "b" },
  ]);
});
