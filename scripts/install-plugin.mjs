#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "codex-iab-backend";
const marketplaceName = "personal";
const pluginRoot = repoRoot;
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
const backendLauncher = path.join(repoRoot, "scripts", "start-session-backend.mjs");
const home = os.homedir();
const pluginLink = path.join(home, "plugins", pluginName);
const marketplacePath = path.join(home, ".agents", "plugins", "marketplace.json");
const args = new Set(process.argv.slice(2));
const skipCodexInstall = args.has("--no-codex-install");
const skipCachebuster = args.has("--no-cachebuster");

await requireProjectShape();
const manifest = await updateManifestVersion();
await ensurePluginSymlink();
await ensureMarketplaceEntry();
await runLocalValidation();

if (!skipCodexInstall) {
  const install = spawnSync("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (install.error) throw install.error;
  if (install.status !== 0) process.exit(install.status ?? 1);
}

console.log(JSON.stringify({
  ok: true,
  plugin: `${pluginName}@${marketplaceName}`,
  version: manifest.version,
  pluginRoot,
  pluginLink,
  marketplacePath,
  installedWithCodex: !skipCodexInstall,
}, null, 2));

async function requireProjectShape() {
  for (const file of [pluginRoot, manifestPath, hooksPath, backendLauncher]) {
    if (!existsSync(file)) throw new Error(`Required path is missing: ${file}`);
  }
}

async function updateManifestVersion() {
  const manifest = await readJson(manifestPath);
  if (skipCachebuster) return manifest;

  const baseVersion = String(manifest.version ?? "0.1.0").split("+")[0];
  manifest.version = `${baseVersion}+codex.local-${utcStamp()}`;
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function ensurePluginSymlink() {
  await mkdir(path.dirname(pluginLink), { recursive: true });

  const linkInfo = await lstat(pluginLink).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (linkInfo) {
    const currentTarget = await realpath(pluginLink).catch(() => null);
    const wantedTarget = await realpath(pluginRoot);

    if (currentTarget !== wantedTarget && !linkInfo.isSymbolicLink()) {
      throw new Error(`${pluginLink} exists and is not this plugin. Move it before installing.`);
    }

    if (linkInfo.isSymbolicLink()) {
      await unlink(pluginLink);
    } else {
      await rm(pluginLink, { force: true, recursive: linkInfo.isDirectory() });
    }
  }

  await symlink(pluginRoot, pluginLink, "dir");
}

async function ensureMarketplaceEntry() {
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  const marketplace = existsSync(marketplacePath)
    ? await readJson(marketplacePath)
    : { name: marketplaceName, interface: { displayName: "Personal" }, plugins: [] };

  marketplace.name ??= marketplaceName;
  marketplace.interface ??= { displayName: "Personal" };
  marketplace.interface.displayName ??= "Personal";
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const entry = {
    name: pluginName,
    source: {
      source: "local",
      path: `./plugins/${pluginName}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Engineering",
  };

  const index = marketplace.plugins.findIndex((plugin) => plugin.name === pluginName);
  if (index >= 0) marketplace.plugins[index] = entry;
  else marketplace.plugins.push(entry);

  await writeJson(marketplacePath, marketplace);
}

async function runLocalValidation() {
  const validation = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "validate-plugin.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (validation.error) throw validation.error;
  if (validation.status !== 0) process.exit(validation.status ?? 1);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function utcStamp() {
  const iso = new Date().toISOString();
  return iso.slice(0, 19).replaceAll("-", "").replace("T", "-").replaceAll(":", "");
}
