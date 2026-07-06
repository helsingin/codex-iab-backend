#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { decodeFrames, encodeFrame } from "../src/framing.mjs";
import { sessionSocketName } from "../src/session-hook.mjs";

if (isMain()) await main();

export function sendRpc(socketPath, message, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    let finished = false;

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for ${socketPath}`));
      socket.destroy();
    }, timeoutMs);

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    }

    socket.on("connect", () => socket.write(encodeFrame(message)));
    socket.on("data", (chunk) => {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        const decoded = decodeFrames(buffered);
        buffered = decoded.remaining;
        const response = decoded.messages.find((item) => item.id === message.id);
        if (response) {
          socket.end();
          finish(null, response);
        }
      } catch (error) {
        socket.destroy();
        finish(error);
      }
    });
    socket.on("error", finish);
  });
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    i++;
  }
  return parsed;
}

function numberArg(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = numberArg(args.timeoutMs, 2000);
  const pipeDir = args.pipeDir ?? process.env.CODEX_IAB_PIPE_DIR ?? "/tmp/codex-browser-use";
  const socketPath = args.socketPath
    ?? args._[0]
    ?? (args.sessionId ? path.join(pipeDir, sessionSocketName(args.sessionId)) : null);

  if (!socketPath) {
    console.error("Usage: node scripts/probe-socket.mjs <socket-path>");
    console.error("   or: node scripts/probe-socket.mjs --session-id <codex-session-id>");
    process.exit(2);
  }

  try {
    const response = await sendRpc(socketPath, {
      jsonrpc: "2.0",
      id: 1,
      method: args.method ?? "getInfo",
      params: {},
    }, timeoutMs);

    if (response.error) {
      console.error(JSON.stringify(response.error, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify(response.result ?? response, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
