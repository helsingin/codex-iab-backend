#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "codex-iab-backend";
const distDir = path.join(repoRoot, "dist");
const packageDir = path.join(distDir, pluginName);
const archivePath = path.join(distDir, `${pluginName}.tar.gz`);

await runValidation();
await rm(packageDir, { force: true, recursive: true });
await rm(archivePath, { force: true });
await mkdir(packageDir, { recursive: true });

for (const entry of [
  ".codex-plugin",
  ".codex-pluginignore",
  ".gitignore",
  "hooks",
  "src",
  "scripts",
  "test",
  "docs",
  "Makefile",
  "LICENSE",
  "README.md",
  "package.json",
]) {
  const source = path.join(repoRoot, entry);
  if (!existsSync(source)) continue;
  await cp(source, path.join(packageDir, entry), {
    recursive: true,
    filter: shouldCopy,
  });
}

const tar = spawnSync("tar", ["-czf", archivePath, pluginName], {
  cwd: distDir,
  stdio: "inherit",
});
if (tar.error) throw tar.error;
if (tar.status !== 0) process.exit(tar.status ?? 1);

console.log(JSON.stringify({
  ok: true,
  packageDir,
  archivePath,
}, null, 2));

async function runValidation() {
  const validation = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "validate-plugin.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (validation.error) throw validation.error;
  if (validation.status !== 0) process.exit(validation.status ?? 1);
}

function shouldCopy(source) {
  const relative = path.relative(repoRoot, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.includes(".git")) return false;
  if (parts.includes("node_modules")) return false;
  if (parts.includes("dist")) return false;
  if (parts.includes("coverage")) return false;
  if (relative.endsWith(".log") || relative.endsWith(".sock")) return false;
  return true;
}
