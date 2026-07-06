#!/usr/bin/env node
import { readdir, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const stateDir = process.env.CODEX_IAB_STATE_DIR ?? path.join(os.tmpdir(), "codex-iab-backend");
const pipeDir = process.env.CODEX_IAB_PIPE_DIR ?? "/tmp/codex-browser-use";
const summary = {
  killed: [],
  removedStateFiles: [],
  removedSockets: [],
  staleStateFiles: [],
  errors: [],
};

await cleanupStateFiles();
await cleanupOrphanSockets();

console.log(JSON.stringify(summary, null, 2));

async function cleanupStateFiles() {
  const entries = await safeReaddir(stateDir);
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const statePath = path.join(stateDir, entry);
    const state = await readJson(statePath);

    if (!state) {
      summary.staleStateFiles.push(statePath);
      await removePath(statePath, summary.removedStateFiles);
      continue;
    }

    if (state.pid && isProcessAlive(state.pid)) {
      const killed = await terminateProcess(state.pid);
      if (killed) summary.killed.push(state.pid);
    }

    if (state.socketPath) await removePath(state.socketPath, summary.removedSockets);
    await removePath(statePath, summary.removedStateFiles);
  }
}

async function cleanupOrphanSockets() {
  const entries = await safeReaddir(pipeDir);
  for (const entry of entries.filter((name) => /^codex-iab-.*\.sock$/.test(name))) {
    const socketPath = path.join(pipeDir, entry);
    if (await acceptsConnection(socketPath)) continue;
    await removePath(socketPath, summary.removedSockets);
  }
}

async function terminateProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return false;
    summary.errors.push({ pid, error: error.message });
    return false;
  }

  const stopped = await waitForExit(pid, 750);
  if (stopped) return true;

  try {
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 500);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    summary.errors.push({ pid, error: error.message });
    return false;
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

async function waitForExit(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

async function acceptsConnection(socketPath) {
  try {
    const info = await stat(socketPath);
    if (!info.isSocket()) return false;
  } catch {
    return false;
  }

  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 200);

    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function removePath(file, bucket) {
  try {
    await rm(file, { force: true });
    bucket.push(file);
  } catch (error) {
    summary.errors.push({ path: file, error: error.message });
  }
}
