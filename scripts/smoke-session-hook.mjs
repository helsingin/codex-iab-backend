#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sendRpc } from "./probe-socket.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const keep = Boolean(args.keep);
const timeoutMs = numberArg(args.timeoutMs, 90000);
const hookDump = path.join(os.tmpdir(), `codex-iab-plugin-smoke-${Date.now()}-${process.pid}.json`);
const smokeCwd = path.join(os.tmpdir(), `codex-iab-plugin-smoke-cwd-${Date.now()}-${process.pid}`);

let dump = null;
try {
  await mkdir(smokeCwd, { recursive: true });
  await runCodexExec({
    cwd: smokeCwd,
    timeoutMs,
    env: {
      ...process.env,
      CODEX_IAB_BACKEND_HOOK_DUMP: hookDump,
      CODEX_IAB_IDLE_TIMEOUT_MS: String(numberArg(args.idleTimeoutMs, 300000)),
    },
  });

  dump = await readDump(hookDump);
  const result = dump.result ?? {};
  if (!result.socketPath) throw new Error(`Hook did not report a socket path: ${JSON.stringify(result)}`);

  const response = await pollSocket(result.socketPath, result.sessionId, numberArg(args.probeTimeoutMs, 15000));
  console.log(JSON.stringify({
    ok: true,
    sessionId: result.sessionId,
    pid: result.pid,
    socketPath: result.socketPath,
    hookStartedBackend: result.started === true,
    backendInfo: response.result,
  }, null, 2));
} finally {
  if (!keep && dump?.result?.started === true && dump.result.pid) {
    await terminateProcess(dump.result.pid);
  }
  if (!keep && dump?.result?.socketPath) {
    await rm(dump.result.socketPath, { force: true }).catch(() => {});
  }
  if (!keep && existsSync(hookDump)) {
    await rm(hookDump, { force: true }).catch(() => {});
  }
  if (!keep && existsSync(smokeCwd)) {
    await rm(smokeCwd, { force: true, recursive: true }).catch(() => {});
  }
}

async function runCodexExec({ cwd, env, timeoutMs }) {
  await new Promise((resolve, reject) => {
    const child = spawn("codex", [
      "exec",
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
      "Reply only: ok",
    ], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let done = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`codex exec failed with ${signal ?? code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function readDump(file) {
  if (!existsSync(file)) {
    throw new Error(`Hook dump was not written: ${file}`);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

async function pollSocket(socketPath, expectedSessionId, timeoutMs) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await sendRpc(socketPath, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: {},
      }, 1000);
      if (response.error) throw new Error(response.error.message);
      const actual = response.result?.metadata?.codexSessionId;
      if (actual !== expectedSessionId) {
        throw new Error(`Socket session mismatch: expected ${expectedSessionId}, got ${actual}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError ?? new Error(`Timed out probing ${socketPath}`);
}

async function terminateProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "keep") {
      parsed.keep = true;
      continue;
    }
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
