import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CdpConnection, withTimeout } from "./cdp-connection.mjs";

const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export class ChromeEngine {
  constructor({
    chromePath,
    headless = true,
    userDataDir,
    viewport = { width: 1280, height: 720 },
    startupTimeoutMs = 10000,
  } = {}) {
    this.chromePath = chromePath;
    this.headless = headless;
    this.userDataDir = userDataDir;
    this.ownsUserDataDir = !userDataDir;
    this.viewport = viewport;
    this.startupTimeoutMs = startupTimeoutMs;
    this.process = null;
    this.port = null;
    this.browserConnection = null;
    this.pages = new Map();
    this.nextTabId = 1;
    this.activeTabId = null;
    this.stderr = "";
  }

  async start() {
    if (this.process) return this;

    const chromePath = this.chromePath ?? findChromePath();
    if (!chromePath) {
      throw new Error("Chrome was not found. Set CODEX_IAB_CHROME_PATH or pass --chrome-path.");
    }

    this.userDataDir ??= await mkdtemp(path.join(os.tmpdir(), "codex-iab-chrome-"));

    const args = [
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-popup-blocking",
      "--hide-crash-restore-bubble",
      `--window-size=${this.viewport.width},${this.viewport.height}`,
    ];

    if (this.headless) args.push("--headless=new");
    args.push("about:blank");

    this.process = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.process.stderr?.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });

    const activePort = await this.readDevToolsActivePort();
    this.port = activePort.port;
    this.browserConnection = new CdpConnection(`ws://127.0.0.1:${activePort.port}${activePort.browserPath}`);
    await this.browserConnection.connect();

    return this;
  }

  async stop() {
    for (const page of [...this.pages.values()]) {
      await page.close().catch(() => {});
    }
    this.pages.clear();

    await this.browserConnection?.close().catch(() => {});
    this.browserConnection = null;

    if (this.process) {
      const proc = this.process;
      this.process = null;
      if (!proc.killed) proc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => proc.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (!proc.killed) proc.kill("SIGKILL");
    }

    if (this.ownsUserDataDir && this.userDataDir) {
      await rm(this.userDataDir, { force: true, recursive: true }).catch(() => {});
    }
  }

  async createTab(url = "about:blank") {
    await this.start();
    const { targetId } = await this.browserConnection.send("Target.createTarget", { url });
    const target = await this.findTarget(targetId);
    const tabId = String(this.nextTabId++);
    const page = new ChromePage({ connectionUrl: target.webSocketDebuggerUrl, id: tabId, targetId, engine: this });
    await page.connect();
    this.pages.set(tabId, page);
    this.activeTabId = tabId;
    return await page.info({ active: true });
  }

  async listTabs() {
    const tabs = [];
    for (const [id, page] of this.pages.entries()) {
      if (!page.closed) tabs.push(await page.info({ active: id === this.activeTabId }));
    }
    return tabs;
  }

  async selectedTab() {
    if (!this.activeTabId) return {};
    const page = this.pages.get(this.activeTabId);
    if (!page || page.closed) return {};
    return await page.info({ active: true });
  }

  async closeTab(id) {
    const page = this.getPage(id);
    await page.close();
    this.pages.delete(String(id));
    if (this.activeTabId === String(id)) this.activeTabId = this.pages.keys().next().value ?? null;
    return {};
  }

  async navigateTab(id, url, options = {}) {
    const page = this.getPage(id);
    this.activeTabId = String(id);
    await page.navigate(url, options);
    return {};
  }

  async back(id) {
    await this.getPage(id).historyDelta(-1);
    return {};
  }

  async forward(id) {
    await this.getPage(id).historyDelta(1);
    return {};
  }

  async reload(id) {
    await this.getPage(id).reload();
    return {};
  }

  async screenshot(id, options = {}) {
    return { data: await this.getPage(id).screenshot(options) };
  }

  async evaluate(id, script, options = {}) {
    return { value: await this.getPage(id).evaluateScript(script, options) };
  }

  async domSnapshot(id) {
    return { dom_snapshot: await this.getPage(id).domSnapshot() };
  }

  async waitForLoadState(id, options = {}) {
    await this.getPage(id).waitForLoadState(options);
    return {};
  }

  async waitForUrl(id, options = {}) {
    const url = await this.getPage(id).waitForUrl(options);
    return { url };
  }

  async waitForTimeout(_id, timeoutMs = 0) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return {};
  }

  async executeCdp({ target = {}, method, commandParams, params, timeoutMs } = {}) {
    if (!method) throw new Error("executeCdp requires method");
    if (target.tabId == null) {
      return await this.browserConnection.send(method, commandParams ?? params ?? {}, { timeoutMs });
    }
    return await this.getPage(target.tabId).connection.send(method, commandParams ?? params ?? {}, { timeoutMs });
  }

  async tabsContent({ urls, content_type: contentType = "text", timeout_ms: timeoutMs } = {}) {
    const results = [];
    for (const url of urls ?? []) {
      const tab = await this.createTab("about:blank");
      try {
        await this.navigateTab(tab.id, url, { timeoutMs });
        const page = this.getPage(tab.id);
        const content = await page.readContent(contentType);
        const info = await page.info();
        results.push({ url: info.url ?? url, title: info.title ?? null, content });
      } finally {
        await this.closeTab(tab.id).catch(() => {});
      }
    }
    return { results };
  }

  getPage(id) {
    const page = this.pages.get(String(id));
    if (!page || page.closed) throw new Error(`Unknown tab id: ${id}`);
    return page;
  }

  async readDevToolsActivePort() {
    const file = path.join(this.userDataDir, "DevToolsActivePort");
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.startupTimeoutMs) {
      if (this.process?.exitCode != null) {
        throw new Error(`Chrome exited before DevTools was ready. ${this.stderr.trim()}`);
      }

      try {
        const [portLine, browserPath] = (await readFile(file, "utf8")).trim().split(/\r?\n/);
        const port = Number(portLine);
        if (Number.isInteger(port) && browserPath) return { port, browserPath };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    throw new Error(`Timed out waiting for Chrome DevToolsActivePort. ${this.stderr.trim()}`);
  }

  async findTarget(targetId) {
    const targets = await this.fetchJson(`/json/list`);
    const target = targets.find((item) => item.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error(`Could not find target websocket for ${targetId}`);
    return target;
  }

  async targetMetadata(targetId) {
    const targets = await this.fetchJson(`/json/list`);
    return targets.find((item) => item.id === targetId) ?? {};
  }

  async fetchJson(route) {
    const response = await fetch(`http://127.0.0.1:${this.port}${route}`);
    if (!response.ok) throw new Error(`Chrome DevTools HTTP ${response.status} for ${route}`);
    return await response.json();
  }
}

class ChromePage {
  constructor({ connectionUrl, engine, id, targetId }) {
    this.connectionUrl = connectionUrl;
    this.engine = engine;
    this.id = id;
    this.targetId = targetId;
    this.connection = new CdpConnection(connectionUrl);
    this.closed = false;
  }

  async connect() {
    await this.connection.connect();
    await Promise.all([
      this.connection.send("Page.enable"),
      this.connection.send("Runtime.enable"),
    ]);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close().catch(() => {});
    await this.engine.browserConnection?.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }

  async info(extra = {}) {
    const target = await this.engine.targetMetadata(this.targetId).catch(() => ({}));
    let value = {
      title: target.title || undefined,
      url: target.url || undefined,
    };
    if (value.title || value.url) return { id: this.id, ...value, ...extra };
    try {
      value = await this.evaluateExpression("({ title: document.title || undefined, url: location.href || undefined })", {
        timeoutMs: 500,
      });
    } catch {
    }
    return { id: this.id, ...value, ...extra };
  }

  async navigate(url, { timeout_ms: timeoutMsSnake, timeoutMs: timeoutMsCamel } = {}) {
    const timeoutMs = timeoutMsCamel ?? timeoutMsSnake ?? 15000;
    const loadPromise = this.connection.waitForEvent("Page.loadEventFired", { timeoutMs }).catch(() => null);
    const result = await this.connection.send("Page.navigate", { url }, { timeoutMs });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await loadPromise;
  }

  async historyDelta(delta) {
    const history = await this.connection.send("Page.getNavigationHistory");
    const nextIndex = history.currentIndex + delta;
    const entry = history.entries?.[nextIndex];
    if (!entry) return;
    const loadPromise = this.connection.waitForEvent("Page.loadEventFired", { timeoutMs: 10000 }).catch(() => null);
    await this.connection.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await loadPromise;
  }

  async reload() {
    const loadPromise = this.connection.waitForEvent("Page.loadEventFired", { timeoutMs: 10000 }).catch(() => null);
    await this.connection.send("Page.reload", { ignoreCache: false });
    await loadPromise;
  }

  async screenshot({ fullPage, cropX, cropY, cropWidth, cropHeight } = {}) {
    const params = { format: "png", fromSurface: true, captureBeyondViewport: Boolean(fullPage) };
    if ([cropX, cropY, cropWidth, cropHeight].every((value) => typeof value === "number")) {
      params.clip = { x: cropX, y: cropY, width: cropWidth, height: cropHeight, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.connection.send("Page.captureScreenshot", params, { timeoutMs: 15000 });
    return data;
  }

  async evaluateScript(script, { timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    const timeout = timeoutMsCamel ?? timeoutMs ?? 5000;
    return await this.evaluateExpression(`(async () => {\n${script}\n})()`, { timeoutMs: timeout });
  }

  async evaluateExpression(expression, { timeoutMs = 5000 } = {}) {
    const result = await this.connection.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
        userGesture: false,
      },
      { timeoutMs: timeoutMs + 1000 },
    );

    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed";
      throw new Error(message);
    }

    return remoteObjectValue(result.result);
  }

  async domSnapshot() {
    return await this.evaluateExpression(`(${domSnapshotSource.toString()})()`, { timeoutMs: 5000 });
  }

  async readContent(contentType) {
    if (contentType === "html") return await this.evaluateExpression("document.documentElement.outerHTML");
    if (contentType === "domSnapshot") return await this.domSnapshot();
    return await this.evaluateExpression("document.body ? document.body.innerText : document.documentElement.innerText");
  }

  async waitForLoadState({ state = "load", timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    const timeout = timeoutMsCamel ?? timeoutMs ?? 10000;
    if (state === "domcontentloaded") {
      if (await this.hasReachedReadyState(["interactive", "complete"], timeout)) return;
      await this.connection.waitForEvent("Page.domContentEventFired", { timeoutMs: timeout });
      return;
    }
    if (state === "networkidle") {
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeout, 500)));
      return;
    }
    if (await this.hasReachedReadyState(["complete"], timeout)) return;
    await this.connection.waitForEvent("Page.loadEventFired", { timeoutMs: timeout });
  }

  async hasReachedReadyState(acceptedStates, timeoutMs) {
    try {
      const readyState = await this.evaluateExpression("document.readyState", { timeoutMs: Math.min(timeoutMs, 1000) });
      return acceptedStates.includes(readyState);
    } catch {
      return false;
    }
  }

  async waitForUrl({ url, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    const timeout = timeoutMsCamel ?? timeoutMs ?? 10000;
    return await withTimeout(
      new Promise((resolve) => {
        const tick = async () => {
          const current = (await this.info()).url ?? "";
          if (urlMatches(current, url)) {
            resolve(current);
            return;
          }
          setTimeout(tick, 100);
        };
        void tick();
      }),
      timeout,
      `Timed out waiting for URL ${url}`,
    );
  }
}

function remoteObjectValue(result) {
  if (!result) return undefined;
  if (Object.hasOwn(result, "value")) return result.value;
  switch (result.unserializableValue) {
    case "-0":
      return -0;
    case "NaN":
    case "Infinity":
    case "-Infinity":
      return null;
    default:
      if (typeof result.unserializableValue === "string" && result.unserializableValue.endsWith("n")) {
        return result.unserializableValue.slice(0, -1);
      }
      return undefined;
  }
}

function domSnapshotSource() {
  const lines = [];
  let count = 0;
  const maxNodes = 600;

  const push = (depth, text) => {
    if (count++ < maxNodes) lines.push(`${"  ".repeat(depth)}${text}`);
  };

  const attrs = (element) => {
    const names = ["id", "class", "role", "aria-label", "data-testid", "href", "src", "alt", "title", "type", "name", "placeholder"];
    return names
      .map((name) => {
        const value = element.getAttribute?.(name);
        return value ? `${name}=${JSON.stringify(value)}` : null;
      })
      .filter(Boolean)
      .join(" ");
  };

  const textPreview = (node) => {
    const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    return text ? ` ${JSON.stringify(text.slice(0, 120))}` : "";
  };

  const walk = (node, depth = 0) => {
    if (!node || count >= maxNodes) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (text) push(depth, text.slice(0, 160));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const attrText = attrs(node);
    push(depth, `<${node.tagName.toLowerCase()}${attrText ? ` ${attrText}` : ""}>${textPreview(node)}`);
    for (const child of node.children) walk(child, depth + 1);
  };

  walk(document.documentElement);
  if (count >= maxNodes) lines.push(`[truncated after ${maxNodes} nodes]`);
  return lines.join("\n");
}

function urlMatches(current, expected) {
  if (!expected) return true;
  if (current === expected) return true;
  if (!expected.includes("*")) return false;
  const pattern = `^${expected.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(pattern).test(current);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findChromePath() {
  for (const candidate of DEFAULT_CHROME_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
