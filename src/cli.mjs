#!/usr/bin/env node
import process from "node:process";

import { CodexIabBackend } from "./backend.mjs";
import { ChromeEngine } from "./chrome-engine.mjs";
import { IabSocketServer } from "./server.mjs";
import { sessionSocketName } from "./session-hook.mjs";

const args = parseArgs(process.argv.slice(2));
const headlessValue = args.headless ?? process.env.CODEX_IAB_HEADLESS;

const sessionId = args.sessionId ?? process.env.CODEX_SESSION_ID;
if (!sessionId) {
  console.error("CODEX_SESSION_ID or --session-id is required");
  process.exit(2);
}

const engine = new ChromeEngine({
  chromePath: args.chromePath ?? process.env.CODEX_IAB_CHROME_PATH,
  headless: headlessValue == null ? true : parseBoolean(headlessValue),
});

const backend = new CodexIabBackend({
  buildFlavor: args.buildFlavor ?? process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR ?? "prod",
  engine,
  name: args.name ?? "Local IAB Backend",
  sessionId,
});

const server = new IabSocketServer({
  backend,
  pipeDir: args.pipeDir ?? process.env.CODEX_IAB_PIPE_DIR ?? "/tmp/codex-browser-use",
  socketName: args.socketName ?? process.env.CODEX_IAB_SOCKET_NAME ?? sessionSocketName(sessionId),
});

await engine.start();
await server.start();
console.log(JSON.stringify({ socketPath: server.socketPath, sessionId }));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.stop().catch(() => {});
  await engine.stop().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const idleTimeoutMs = Number(args.idleTimeoutMs ?? process.env.CODEX_IAB_IDLE_TIMEOUT_MS ?? 0);
if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
  setInterval(() => {
    if (Date.now() - server.lastActivity > idleTimeoutMs) void shutdown();
  }, Math.min(idleTimeoutMs, 60000)).unref();
}

await new Promise(() => {});

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
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

function parseBoolean(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
