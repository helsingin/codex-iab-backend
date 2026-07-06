import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("broadcasts backend notifications to connected clients", async () => {
  const pipeDir = await mkdtemp(path.join(os.tmpdir(), "iab-server-test-"));
  const backend = new FakeBackend();
  const server = new IabSocketServer({
    backend,
    pipeDir,
    socketName: "backend.sock",
  });

  await server.start();
  const socket = net.createConnection(server.socketPath);
  try {
    const messagePromise = readOneMessage(socket);
    await new Promise((resolve) => socket.once("connect", resolve));
    backend.emit("notification", {
      method: "onCDPEvent",
      params: { method: "Page.loadEventFired", source: { tabId: 1 } },
    });

    assert.deepEqual(await messagePromise, {
      jsonrpc: "2.0",
      method: "onCDPEvent",
      params: { method: "Page.loadEventFired", source: { tabId: 1 } },
    });
  } finally {
    socket.destroy();
    await server.stop();
    await rm(pipeDir, { force: true, recursive: true });
  }
});

test("does not unlink an active socket owned by another backend", async () => {
  const pipeDir = await mkdtemp(path.join(os.tmpdir(), "iab-server-test-"));
  const first = new IabSocketServer({
    backend: new CodexIabBackend({ engine: { listTabs: async () => [] }, sessionId: "session-1" }),
    pipeDir,
    socketName: "backend.sock",
  });
  const second = new IabSocketServer({
    backend: new CodexIabBackend({ engine: { listTabs: async () => [] }, sessionId: "session-2" }),
    pipeDir,
    socketName: "backend.sock",
  });

  await first.start();
  try {
    await assert.rejects(() => second.start(), /IAB socket is already active/);
    const response = await sendRpc(first.socketPath, { jsonrpc: "2.0", id: 1, method: "getInfo", params: {} });
    assert.equal(response.result.metadata.codexSessionId, "session-1");
  } finally {
    await first.stop();
    await rm(pipeDir, { force: true, recursive: true });
  }
});

class FakeBackend extends EventEmitter {
  async handle(method) {
    if (method === "getInfo") {
      return { type: "iab", metadata: { codexSessionId: "session-1" }, capabilities: { browser: [], tab: [] } };
    }
    return {};
  }
}

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

function readOneMessage(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        const decoded = decodeFrames(buffered);
        buffered = decoded.remaining;
        if (decoded.messages[0]) resolve(decoded.messages[0]);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}
