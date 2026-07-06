import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { rpcError, rpcResult } from "./backend.mjs";
import { decodeFrames, encodeFrame } from "./framing.mjs";

export class IabSocketServer {
  constructor({
    backend,
    pipeDir = "/tmp/codex-browser-use",
    socketName = `local-${process.pid}.sock`,
    socketPath = path.join(pipeDir, socketName),
  }) {
    if (!backend) throw new Error("backend is required");
    this.backend = backend;
    this.pipeDir = pipeDir;
    this.socketPath = socketPath;
    this.server = null;
    this.sockets = new Set();
    this.lastActivity = Date.now();
  }

  async start() {
    if (this.server) return this;
    await mkdir(path.dirname(this.socketPath), { recursive: true });
    await rm(this.socketPath, { force: true });

    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));

      let buffered = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        this.lastActivity = Date.now();
        buffered = Buffer.concat([buffered, chunk]);
        let decoded;
        try {
          decoded = decodeFrames(buffered);
        } catch (error) {
          socket.write(encodeFrame(rpcError(null, error)));
          buffered = Buffer.alloc(0);
          return;
        }
        buffered = decoded.remaining;

        for (const message of decoded.messages) {
          void this.respond(socket, message);
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    return this;
  }

  async stop() {
    const server = this.server;
    this.server = null;

    if (server) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    }

    await rm(this.socketPath, { force: true }).catch(() => {});
  }

  async respond(socket, message) {
    this.lastActivity = Date.now();
    if (message?.jsonrpc !== "2.0" || message.id == null || typeof message.method !== "string") {
      return;
    }

    try {
      const result = await this.backend.handle(message.method, message.params ?? {});
      socket.write(encodeFrame(rpcResult(message.id, result)));
    } catch (error) {
      socket.write(encodeFrame(rpcError(message.id, error)));
    }
  }
}
