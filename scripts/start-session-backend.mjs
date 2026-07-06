#!/usr/bin/env node
import { ensureSessionBackend, readHookPayload } from "../src/session-hook.mjs";

const hookPayload = await readHookPayload();
const result = await ensureSessionBackend({ hookPayload });

if (process.env.CODEX_IAB_BACKEND_HOOK_DUMP) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.CODEX_IAB_BACKEND_HOOK_DUMP, JSON.stringify({ hookPayload, result }, null, 2));
}

if (process.env.CODEX_IAB_BACKEND_VERBOSE === "1") {
  console.log(JSON.stringify(result));
}
