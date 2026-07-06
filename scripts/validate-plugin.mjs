#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = repoRoot;
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
const hookEntrypointPath = path.join(pluginRoot, "scripts", "start-session-backend.mjs");

const errors = [];

const manifest = await readJson(manifestPath, "plugin manifest");
if (manifest) validateManifest(manifest);

const hooks = await readJson(hooksPath, "hooks file");
if (hooks) validateHooks(hooks);

await requireFile(hookEntrypointPath, "plugin hook entrypoint");
await assertNoTodoPlaceholders(path.join(pluginRoot, ".codex-plugin"));
await assertNoTodoPlaceholders(path.join(pluginRoot, "hooks"));

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  pluginRoot,
  manifest: manifestPath,
  hooks: hooksPath,
  version: manifest.version,
}, null, 2));

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    errors.push(`Invalid or missing ${label} at ${file}: ${error.message}`);
    return null;
  }
}

function validateManifest(manifest) {
  requireString(manifest.name, "plugin.json name");
  requireString(manifest.version, "plugin.json version");
  requireString(manifest.description, "plugin.json description");
  requireString(manifest.author?.name, "plugin.json author.name");
  requireString(manifest.interface?.displayName, "plugin.json interface.displayName");
  requireString(manifest.interface?.shortDescription, "plugin.json interface.shortDescription");
  requireString(manifest.interface?.longDescription, "plugin.json interface.longDescription");
  requireString(manifest.interface?.developerName, "plugin.json interface.developerName");
  requireString(manifest.interface?.category, "plugin.json interface.category");

  if (manifest.name !== "codex-iab-backend") {
    errors.push(`plugin.json name must be codex-iab-backend, got ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.license !== "Apache-2.0") {
    errors.push("plugin.json license must be Apache-2.0");
  }
  if (Object.hasOwn(manifest, "hooks")) {
    errors.push("plugin.json must not include hooks; hooks belong in hooks/hooks.json");
  }
  if (Object.hasOwn(manifest, "mcpServers")) {
    errors.push("plugin.json must not include mcpServers unless .mcp.json is created");
  }
  if (Object.hasOwn(manifest, "apps")) {
    errors.push("plugin.json must not include apps unless .app.json is created");
  }
}

function validateHooks(hooks) {
  const sessionStart = hooks.hooks?.SessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length === 0) {
    errors.push("hooks/hooks.json must define hooks.SessionStart");
    return;
  }

  const commands = sessionStart
    .flatMap((entry) => entry.hooks ?? [])
    .filter((hook) => hook.type === "command")
    .map((hook) => hook.command);

  if (commands.length === 0) {
    errors.push("hooks.SessionStart must include at least one command hook");
  }
  if (!commands.some((command) => typeof command === "string" && command.includes("scripts/start-session-backend.mjs"))) {
    errors.push("SessionStart command must call scripts/start-session-backend.mjs");
  }
  for (const command of commands) {
    if (typeof command !== "string") continue;
    if (command.includes(process.env.HOME ?? "\0") || command.includes("/Users/")) {
      errors.push(`SessionStart command must be portable, got absolute user path: ${command}`);
    }
  }
}

async function assertNoTodoPlaceholders(root) {
  for await (const file of walk(root)) {
    const text = await readFile(file, "utf8");
    if (text.includes("[TODO:") || text.includes("TODO_PLUGIN")) {
      errors.push(`Unresolved placeholder in ${file}`);
    }
  }
}

async function* walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function requireFile(file, label) {
  try {
    const info = await stat(file);
    if (!info.isFile()) errors.push(`${label} is not a file: ${file}`);
  } catch (error) {
    errors.push(`Missing ${label} at ${file}: ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}
