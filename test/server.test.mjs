import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexIabBackend } from "../src/backend.mjs";
import { decodeFrames, encodeFrame } from "../src/framing.mjs";
import { IabSocketServer } from "../src/server.mjs";

test("serves framed JSON-RPC over a unix socket", async () => {
  const pipeDir = await mkdtemp(path.join(os.tmpdir(), "iab-server-test-"));
  const server = new IabSocketServer({
    backend: new CodexIabBackend({ engine: { listTabs: async () => [] }, sessionId: "session-1" }),
    pipeDir,
    socketName: "backend.sock",
  });

  await server.start();
  try {
    const response = await sendRpc(server.socketPath, { jsonrpc: "2.0", id: 1, method: "getInfo", params: {} });
    assert.equal(response.id, 1);
    assert.equal(response.result.type, "iab");
    assert.equal(response.result.metadata.codexSessionId, "session-1");
  } finally {
    await server.stop();
    await rm(pipeDir, { force: true, recursive: true });
  }
});

function sendRpc(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);

    socket.on("connect", () => {
      socket.write(encodeFrame(message));
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeFrames(buffered);
      buffered = decoded.remaining;
      if (decoded.messages[0]) {
        socket.end();
        resolve(decoded.messages[0]);
      }
    });
    socket.on("error", reject);
  });
}
