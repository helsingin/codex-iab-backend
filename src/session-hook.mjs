import { existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { decodeFrames, encodeFrame } from "./framing.mjs";

export function extractSessionId(payload = {}, env = process.env) {
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.codex_session_id,
    payload.codexSessionId,
    payload.thread_id,
    payload.threadId,
    payload["x-codex-turn-metadata"]?.session_id,
    payload.turn_metadata?.session_id,
    payload.turnMetadata?.sessionId,
    payload.metadata?.session_id,
    payload.metadata?.sessionId,
    payload.session?.id,
    payload.thread?.id,
    env.CODEX_SESSION_ID,
    env.CODEX_SESSION,
    env.CODEX_THREAD_ID,
  ];

  return candidates.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

export function sessionSocketName(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96);
  return `codex-iab-${safe}.sock`;
}

export async function readHookPayload(stdin = process.stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export async function ensureSessionBackend({
  backendCli = path.resolve(new URL("../src/cli.mjs", import.meta.url).pathname),
  buildFlavor = process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR ?? "prod",
  dryRun = process.env.CODEX_IAB_BACKEND_DRY_RUN === "1",
  env = process.env,
  hookPayload = {},
  idleTimeoutMs = Number(process.env.CODEX_IAB_IDLE_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
  logDir = path.join(os.homedir(), ".codex", "codex-iab-backend", "logs"),
  nodePath = process.execPath,
  pipeDir = process.env.CODEX_IAB_PIPE_DIR ?? "/tmp/codex-browser-use",
  stateDir = path.join(os.tmpdir(), "codex-iab-backend"),
} = {}) {
  const sessionId = extractSessionId(hookPayload, env);
  if (!sessionId) {
    return { started: false, reason: "missing-session-id" };
  }

  const socketName = sessionSocketName(sessionId);
  const socketPath = path.join(pipeDir, socketName);
  const statePath = path.join(stateDir, `${socketName}.json`);

  if (dryRun) {
    return { started: false, dryRun: true, sessionId, socketName, socketPath };
  }

  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const existing = await readState(statePath);
  if (existing?.pid && isProcessAlive(existing.pid) && await socketMatchesSession(socketPath, sessionId)) {
    return { started: false, reason: "already-running", pid: existing.pid, sessionId, socketPath };
  }

  await rm(socketPath, { force: true }).catch(() => {});

  const logPath = path.join(logDir, `${sessionId}.log`);
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");

  const child = spawn(nodePath, [
    backendCli,
    "--session-id",
    sessionId,
    "--socket-name",
    socketName,
    "--headless",
    "true",
    "--idle-timeout-ms",
    String(idleTimeoutMs),
  ], {
    detached: true,
    env: {
      ...env,
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: buildFlavor,
      CODEX_IAB_PIPE_DIR: pipeDir,
      CODEX_IAB_SOCKET_NAME: socketName,
      CODEX_SESSION_ID: sessionId,
    },
    stdio: ["ignore", out, err],
  });

  child.unref();

  await writeFile(statePath, JSON.stringify({
    logPath,
    pid: child.pid,
    sessionId,
    socketPath,
    startedAt: new Date().toISOString(),
  }, null, 2));

  return { started: true, pid: child.pid, sessionId, socketPath, logPath };
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function socketMatchesSession(socketPath, sessionId) {
  if (!existsSync(socketPath)) return false;
  try {
    const response = await sendRpc(socketPath, { jsonrpc: "2.0", id: 1, method: "getInfo", params: {} }, 500);
    return response?.result?.metadata?.codexSessionId === sessionId;
  } catch {
    return false;
  }
}

function sendRpc(socketPath, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for ${socketPath}`));
    }, timeoutMs);

    socket.on("connect", () => socket.write(encodeFrame(message)));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeFrames(buffered);
      buffered = decoded.remaining;
      if (decoded.messages[0]) {
        clearTimeout(timeout);
        socket.end();
        resolve(decoded.messages[0]);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
