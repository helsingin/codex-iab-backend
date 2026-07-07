import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CdpConnection, withTimeout } from "./cdp-connection.mjs";

const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export class ChromeEngine extends EventEmitter {
  constructor({
    chromePath,
    headless = true,
    userDataDir,
    viewport = { width: 1280, height: 720 },
    startupTimeoutMs = 10000,
  } = {}) {
    super();
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
    if (this.process) {
      if (this.process.exitCode != null) {
        this.process = null;
        this.browserConnection = null;
      } else if (this.browserConnection) {
        await this.browserConnection.connect();
        return this;
      }
    }

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

  async locatorCount(id, command = {}) {
    return { count: await this.getPage(id).locatorCount(command) };
  }

  async locatorFill(id, command = {}) {
    await this.getPage(id).locatorFill(command);
    return {};
  }

  async locatorClick(id, command = {}) {
    await this.getPage(id).locatorClick(command);
    return {};
  }

  async locatorDblClick(id, command = {}) {
    await this.getPage(id).locatorClick({ ...command, clickCount: 2 });
    return {};
  }

  async locatorPress(id, command = {}) {
    await this.getPage(id).locatorPress(command);
    return {};
  }

  async locatorWaitFor(id, command = {}) {
    await this.getPage(id).locatorWaitFor(command);
    return {};
  }

  async locatorAllTextContents(id, command = {}) {
    return { values: await this.getPage(id).locatorAllTextContents(command) };
  }

  async locatorTextContent(id, command = {}) {
    return { value: await this.getPage(id).locatorTextContent(command) };
  }

  async locatorInnerText(id, command = {}) {
    return { value: await this.getPage(id).locatorInnerText(command) };
  }

  async locatorGetAttribute(id, command = {}) {
    return { value: await this.getPage(id).locatorGetAttribute(command) };
  }

  async locatorIsVisible(id, command = {}) {
    return { value: await this.getPage(id).locatorIsVisible(command) };
  }

  async locatorIsEnabled(id, command = {}) {
    return { value: await this.getPage(id).locatorIsEnabled(command) };
  }

  async locatorReadAll(id, command = {}) {
    return { values: await this.getPage(id).locatorReadAll(command) };
  }

  async locatorSelectOption(id, command = {}) {
    await this.getPage(id).locatorSelectOption(command);
    return {};
  }

  async locatorSetChecked(id, command = {}) {
    await this.getPage(id).locatorSetChecked(command);
    return {};
  }

  async elementInfo(id, command = {}) {
    return await this.getPage(id).elementInfo(command);
  }

  async elementScreenshot(id, command = {}) {
    return { data: await this.getPage(id).elementScreenshot(command) };
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
    const cdpParams = withCdpCompatibilityPolyfills(method, commandParams ?? params ?? {});
    const startedAt = Date.now();
    try {
      const result = target.tabId == null
        ? await this.browserConnection.send(method, cdpParams, { timeoutMs })
        : await this.getPage(target.tabId).connection.send(method, cdpParams, { timeoutMs });
      debugCdp({ elapsedMs: Date.now() - startedAt, method, ok: true, target });
      return result;
    } catch (error) {
      debugCdp({ elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), method, ok: false, target });
      throw error;
    }
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
    this.mainExecutionContextId = null;
    this.closed = false;
  }

  async connect() {
    await this.connection.connect();
    this.connection.addEventListener("Runtime.executionContextCreated", ({ context }) => {
      if (context?.auxData?.isDefault) this.mainExecutionContextId = context.id;
    });
    this.connection.addEventListener("Runtime.executionContextsCleared", () => {
      this.mainExecutionContextId = null;
    });
    this.connection.addEventListener("*", ({ method, params }) => {
      this.engine.emit("cdpEvent", {
        method,
        params,
        source: { tabId: Number(this.id) },
      });
    });
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
    this.engine.emit("cdpDetach", { tabId: Number(this.id) });
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
    const source = String(script ?? "undefined");
    try {
      return await this.evaluateExpression(playwrightEvaluateExpression(source), { timeoutMs: timeout });
    } catch (error) {
      if (!isEvaluationSyntaxError(error)) throw error;
      return await this.evaluateExpression(`(async () => {\n${source}\n})()`, { timeoutMs: timeout });
    }
  }

  async evaluateExpression(expression, { timeoutMs = 5000 } = {}) {
    const params = {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
      userGesture: false,
    };
    if (this.mainExecutionContextId != null) params.contextId = this.mainExecutionContextId;

    const result = await this.connection.send(
      "Runtime.evaluate",
      params,
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

  async locatorCount({ selector, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    assertLocatorSelector(selector);
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector) => queryLocatorAll(selector).length)(${JSON.stringify(selector)})`,
      { timeoutMs: Math.min(timeoutMsCamel ?? timeoutMs ?? 1000, 5000) },
    );
  }

  async locatorFill({ selector, value = "", timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "visible", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    await this.evaluateExpression(
      `${locatorHelpersSource}\n(${fillLocatorSource.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(String(value))})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorClick({ selector, clickCount = 1, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "visible", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    await this.evaluateExpression(
      `${locatorHelpersSource}\n(${clickLocatorSource.toString()})(${JSON.stringify(selector)}, ${Number(clickCount) === 2 ? 2 : 1})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorPress({ selector, value = "", timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "visible", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    await this.evaluateExpression(
      `${locatorHelpersSource}\n(${pressLocatorSource.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(String(value))})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorWaitFor({ selector, state = "visible", timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state, timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
  }

  async locatorAllTextContents({ selector, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    assertLocatorSelector(selector);
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector) => queryLocatorAll(selector).map((element) => element.textContent ?? ""))(${JSON.stringify(selector)})`,
      { timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 },
    );
  }

  async locatorTextContent({ selector, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "attached", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector) => singleElement(selector, { visible: false }).textContent)(${JSON.stringify(selector)})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorInnerText({ selector, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "attached", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector) => singleElement(selector, { visible: false }).innerText ?? "")(${JSON.stringify(selector)})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorGetAttribute({ selector, name, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    if (typeof name !== "string" || name.length === 0) throw new Error("locator attribute name is required");
    await this.waitForSelector(selector, { state: "attached", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector, name) => singleElement(selector, { visible: false }).getAttribute(name))(${JSON.stringify(selector)}, ${JSON.stringify(name)})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorIsVisible({ selector } = {}) {
    assertLocatorSelector(selector);
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector) => queryLocatorAll(selector).some((element) => elementVisible(element)))(${JSON.stringify(selector)})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorIsEnabled({ selector } = {}) {
    assertLocatorSelector(selector);
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n((selector) => {
        const element = queryLocatorAll(selector)[0] ?? null;
        return element != null && !element.disabled && element.getAttribute("aria-disabled") !== "true";
      })(${JSON.stringify(selector)})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorReadAll({ selector, relative_selector: relativeSelector, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    assertLocatorSelector(selector);
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n(${readAllLocatorSource.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(relativeSelector ?? null)})`,
      { timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 },
    );
  }

  async locatorSelectOption({ selector, selections, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "visible", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    await this.evaluateExpression(
      `${locatorHelpersSource}\n(${selectOptionLocatorSource.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(selections ?? [])})`,
      { timeoutMs: 1000 },
    );
  }

  async locatorSetChecked({ selector, checked, timeout_ms: timeoutMs, timeoutMs: timeoutMsCamel } = {}) {
    await this.waitForSelector(selector, { state: "visible", timeoutMs: timeoutMsCamel ?? timeoutMs ?? 5000 });
    await this.evaluateExpression(
      `${locatorHelpersSource}\n(${setCheckedLocatorSource.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(Boolean(checked))})`,
      { timeoutMs: 1000 },
    );
  }

  async elementInfo({ x, y, include_non_interactable: includeNonInteractable } = {}) {
    return await this.evaluateExpression(
      `${locatorHelpersSource}\n${elementInfoHelpersSource}\n(${elementInfoSource.toString()})(${JSON.stringify(Number(x))}, ${JSON.stringify(Number(y))}, ${JSON.stringify(Boolean(includeNonInteractable))})`,
      { timeoutMs: 1000 },
    );
  }

  async elementScreenshot({ x, y, include_non_interactable: includeNonInteractable } = {}) {
    await this.evaluateExpression(
      `${locatorHelpersSource}\n${elementInfoHelpersSource}\n${elementInfoSource.toString()}\n(${installElementScreenshotOverlaySource.toString()})(${JSON.stringify(Number(x))}, ${JSON.stringify(Number(y))}, ${JSON.stringify(Boolean(includeNonInteractable))})`,
      { timeoutMs: 1000 },
    );
    try {
      return await this.screenshot();
    } finally {
      await this.evaluateExpression("document.getElementById('__codex_iab_element_overlay__')?.remove()", { timeoutMs: 1000 }).catch(() => {});
    }
  }

  async waitForSelector(selector, { state = "visible", timeoutMs = 5000 } = {}) {
    assertLocatorSelector(selector);
    await withTimeout(
      new Promise((resolve) => {
        const tick = async () => {
          try {
            const status = await this.evaluateExpression(
              `${locatorHelpersSource}\n(${selectorStatusSource.toString()})(${JSON.stringify(selector)})`,
              { timeoutMs: Math.min(timeoutMs, 1000) },
            );
            if (selectorStateMatches(status, state)) {
              resolve();
              return;
            }
          } catch {
          }
          setTimeout(tick, 50);
        };
        void tick();
      }),
      timeoutMs,
      `Timed out waiting for selector ${selector} to be ${state}`,
    );
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

function debugCdp(event) {
  if (process.env.CODEX_IAB_DEBUG_CDP !== "1") return;
  console.error(JSON.stringify({ at: new Date().toISOString(), cdp: event }));
}

function withCdpCompatibilityPolyfills(method, params) {
  if (method !== "Runtime.evaluate" || typeof params?.expression !== "string") return params;
  if (!params.expression.includes("incrementalAriaSnapshot")) return params;
  return {
    ...params,
    expression: `${ariaSnapshotPolyfillSource}\n${params.expression}`,
  };
}

const ariaSnapshotPolyfillSource = `
(() => {
  const injected = window.__codexPlaywrightInjected;
  if (!injected || typeof injected.incrementalAriaSnapshot === "function") return;

  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().split(/\\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      if (type !== "hidden") return "textbox";
    }
    return "generic";
  };

  const textOf = (element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
  const labelText = (element) => {
    const values = [];
    if (element.labels) for (const label of element.labels) values.push(textOf(label));
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) values.push(ariaLabel);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\\s+/)) {
        const item = element.ownerDocument.getElementById(id);
        if (item) values.push(textOf(item));
      }
    }
    const alt = element.getAttribute("alt");
    if (alt) values.push(alt);
    return values.find((value) => value && value.trim()) || textOf(element);
  };

  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const describe = (element) => {
    const role = roleFor(element);
    const name = labelText(element);
    const attrs = [];
    for (const attr of ["id", "data-testid", "name", "type", "href", "value"]) {
      const value = attr === "value" && "value" in element ? element.value : element.getAttribute(attr);
      if (value) attrs.push(attr + "=" + JSON.stringify(String(value)));
    }
    return "- " + role + (name ? " " + JSON.stringify(name.slice(0, 120)) : "") + (attrs.length ? " [" + attrs.join(" ") + "]" : "");
  };

  const walk = (element, depth, lines) => {
    if (lines.length >= 600 || !visible(element)) return;
    lines.push("  ".repeat(depth) + describe(element));
    for (const child of Array.from(element.children)) walk(child, depth + 1, lines);
  };

  injected.incrementalAriaSnapshot = (root) => {
    const lines = [];
    const start = root?.nodeType === Node.ELEMENT_NODE ? root : document.body || document.documentElement;
    if (start) walk(start, 0, lines);
    return { full: lines.join("\\n"), iframeDepths: {}, iframeRefs: [] };
  };
})();
`;

function playwrightEvaluateExpression(source) {
  return `(async () => {
const __codexEvalValue = (${source});
if (typeof __codexEvalValue === "function") return await __codexEvalValue();
return await __codexEvalValue;
})()`;
}

function isEvaluationSyntaxError(error) {
  const message = String(error?.message ?? error);
  return message.includes("SyntaxError") ||
    message.includes("Unexpected token") ||
    message.includes("Unexpected identifier") ||
    message.includes("Illegal return statement");
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

function selectorStatusSource(selector) {
  const elements = queryLocatorAll(selector);
  const first = elements[0] ?? null;
  return {
    count: elements.length,
    attached: elements.length > 0,
    visible: first != null && elementVisible(first),
    enabled: first != null && !first.disabled,
  };
}

function selectorStateMatches(status, state) {
  if (state === "attached") return status?.attached === true;
  if (state === "detached") return status?.attached === false;
  if (state === "hidden") return status?.attached === false || status?.visible === false;
  return status?.visible === true;
}

function assertLocatorSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) throw new Error("locator selector is required");
}

const locatorHelpersSource = `
function queryLocatorAll(selector, roots) {
  if (typeof selector !== "string" || selector.length === 0) throw new Error("locator selector is required");
  let current = roots ?? [document];
  for (const part of splitLocatorSelector(selector)) {
    current = applyLocatorPart(current, part.trim());
  }
  return uniqueInOrder(current).filter((value) => value && value.nodeType === Node.ELEMENT_NODE);
}

function splitLocatorSelector(selector) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "\`") {
      quote = char;
      current += char;
      continue;
    }
    if (selector.slice(index, index + 4) === " >> ") {
      parts.push(current);
      current = "";
      index += 3;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.filter((part) => part.length > 0);
}

function applyLocatorPart(current, part) {
  if (!part) return current;
  if (part.startsWith("nth=")) {
    const index = Number(part.slice("nth=".length));
    if (!Number.isInteger(index)) throw new Error("invalid nth locator: " + part);
    const resolved = index < 0 ? current[current.length + index] : current[index];
    return resolved ? [resolved] : [];
  }
  if (part === "visible=true") return current.filter((element) => elementVisible(element));
  if (part === "visible=false") return current.filter((element) => !elementVisible(element));
  if (part === "internal:control=enter-frame") {
    const frames = [];
    for (const element of current) {
      if (element.tagName?.toLowerCase() === "iframe" && element.contentDocument) frames.push(element.contentDocument);
    }
    return frames;
  }
  if (part.startsWith("internal:text=")) return queryText(current, part.slice("internal:text=".length));
  if (part.startsWith("internal:label=")) return queryLabel(current, part.slice("internal:label=".length));
  if (part.startsWith("internal:role=")) return queryRole(current, part.slice("internal:role=".length));
  if (part.startsWith("internal:attr=")) return queryAttr(current, part.slice("internal:attr=".length));
  if (part.startsWith("internal:testid=")) return queryAttr(current, part.slice("internal:testid=".length));
  if (part.startsWith("internal:has-text=")) {
    const matcher = parseTextMatcher(part.slice("internal:has-text=".length));
    return current.filter((element) => matcher(elementText(element)));
  }
  if (part.startsWith("internal:has-not-text=")) {
    const matcher = parseTextMatcher(part.slice("internal:has-not-text=".length));
    return current.filter((element) => !matcher(elementText(element)));
  }
  if (part.startsWith("internal:has=")) {
    const nested = JSON.parse(part.slice("internal:has=".length));
    return current.filter((element) => queryLocatorAll(nested, [element]).length > 0);
  }
  if (part.startsWith("internal:has-not=")) {
    const nested = JSON.parse(part.slice("internal:has-not=".length));
    return current.filter((element) => queryLocatorAll(nested, [element]).length === 0);
  }
  if (part.startsWith("internal:and=")) {
    const nested = JSON.parse(part.slice("internal:and=".length));
    const nestedSet = new Set(queryLocatorAll(nested));
    return current.filter((element) => nestedSet.has(element));
  }
  if (part.startsWith("internal:or=")) {
    const nested = JSON.parse(part.slice("internal:or=".length));
    return uniqueInOrder([...current, ...queryLocatorAll(nested)]);
  }
  if (part.startsWith("internal:")) throw new Error("unsupported locator engine: " + part);
  return queryCss(current, part);
}

function queryCss(roots, selector) {
  const out = [];
  for (const root of roots) {
    const scope = root.nodeType === Node.DOCUMENT_NODE ? root : root;
    try {
      out.push(...scope.querySelectorAll(selector));
    } catch (error) {
      throw new Error("invalid CSS selector: " + selector + ": " + error.message);
    }
  }
  return uniqueInOrder(out);
}

function queryText(roots, rawMatcher) {
  const matcher = parseTextMatcher(rawMatcher);
  return descendantElements(roots).filter((element) => {
    if (!matcher(elementText(element))) return false;
    return !Array.from(element.children).some((child) => matcher(elementText(child)));
  });
}

function queryLabel(roots, rawMatcher) {
  const matcher = parseTextMatcher(rawMatcher);
  const out = [];
  for (const control of descendantElements(roots).filter(isFormControl)) {
    const labels = labelTexts(control);
    const ariaLabel = control.getAttribute("aria-label");
    if (ariaLabel) labels.push(ariaLabel);
    if (labels.some((label) => matcher(label))) out.push(control);
  }
  return uniqueInOrder(out);
}

function queryRole(roots, expression) {
  const match = expression.match(/^([^[]+)(?:\\[name=(.*)\\])?$/);
  if (!match) throw new Error("invalid role locator: " + expression);
  const role = match[1];
  const nameMatcher = match[2] == null ? null : parseTextMatcher(match[2]);
  return descendantElements(roots).filter((element) => {
    if (computedRole(element) !== role) return false;
    return nameMatcher == null || nameMatcher(accessibleName(element));
  });
}

function queryAttr(roots, expression) {
  const match = expression.match(/^\\[([^=\\]]+)=([^\\]]+)\\]$/);
  if (!match) throw new Error("invalid attribute locator: " + expression);
  const name = match[1];
  const matcher = parseTextMatcher(match[2]);
  return descendantElements(roots).filter((element) => {
    const value = element.getAttribute(name);
    return value != null && matcher(value);
  });
}

function descendantElements(roots) {
  const out = [];
  for (const root of roots) {
    if (root.nodeType === Node.ELEMENT_NODE) out.push(root);
    const scope = root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.ELEMENT_NODE ? root : null;
    if (scope) out.push(...scope.querySelectorAll("*"));
  }
  return uniqueInOrder(out);
}

function parseTextMatcher(raw) {
  const value = String(raw);
  if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const lastSlash = value.lastIndexOf("/");
    const pattern = value.slice(1, lastSlash);
    const flags = value.slice(lastSlash + 1).replace(/[^dgimsuvy]/g, "");
    const regexp = new RegExp(pattern, flags);
    return (text) => regexp.test(normalizeText(text));
  }
  const match = value.match(/^("(?:\\\\.|[^"\\\\])*")([is])?$/);
  if (!match) throw new Error("invalid text matcher: " + raw);
  const expected = normalizeText(JSON.parse(match[1]));
  const exact = match[2] === "s";
  if (exact) return (text) => normalizeText(text) === expected;
  const expectedLower = expected.toLowerCase();
  return (text) => normalizeText(text).toLowerCase().includes(expectedLower);
}

function normalizeText(text) {
  return String(text ?? "").replace(/\\s+/g, " ").trim();
}

function elementText(element) {
  return normalizeText(element.innerText ?? element.textContent ?? "");
}

function labelTexts(control) {
  const labels = [];
  if (control.labels) {
    for (const label of control.labels) labels.push(elementText(label));
  }
  const labelledBy = control.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\\s+/)) {
      const element = control.ownerDocument.getElementById(id);
      if (element) labels.push(elementText(element));
    }
  }
  return labels;
}

function isFormControl(element) {
  return ["button", "input", "meter", "output", "progress", "select", "textarea"].includes(element.tagName?.toLowerCase());
}

function computedRole(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit.trim().split(/\\s+/)[0];
  const tag = element.tagName?.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return element.multiple || element.size > 1 ? "listbox" : "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "img") return "img";
  if (tag === "table") return "table";
  if (tag === "th") return "columnheader";
  if (tag === "td") return "cell";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "search") return "searchbox";
    if (!["hidden", "password"].includes(type)) return "textbox";
  }
  return null;
}

function accessibleName(element) {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalizeText(ariaLabel);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = [];
    for (const id of labelledBy.split(/\\s+/)) {
      const item = element.ownerDocument.getElementById(id);
      if (item) parts.push(elementText(item));
    }
    if (parts.length) return normalizeText(parts.join(" "));
  }
  const labels = labelTexts(element);
  if (labels.length) return normalizeText(labels.join(" "));
  if (element.alt) return normalizeText(element.alt);
  if (element.value && ["button", "submit", "reset"].includes((element.type || "").toLowerCase())) return normalizeText(element.value);
  return elementText(element);
}

function singleElement(selector, { visible = true } = {}) {
  const elements = queryLocatorAll(selector);
  if (elements.length !== 1) throw new Error("locator resolved to " + elements.length + " elements: " + selector);
  const element = elements[0];
  if (visible && !elementVisible(element)) throw new Error("locator is not visible: " + selector);
  return element;
}

function uniqueElement(selector) {
  return singleElement(selector, { visible: true });
}

function elementVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function uniqueInOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function allAttributes(element) {
  const out = {};
  for (const attr of element.attributes ?? []) out[attr.name] = attr.value;
  return out;
}
`;

function fillLocatorSource(selector, value) {
  const element = uniqueElement(selector);
  if (element.disabled) throw new Error(`locator is disabled: ${selector}`);
  element.focus();
  const previous = element.value;
  element.value = value;
  if (element.value !== value && element.type === "range") {
    element.value = String(Number(value));
  }
  if (element.value !== previous) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function clickLocatorSource(selector, clickCount) {
  const element = uniqueElement(selector);
  if (element.disabled) throw new Error(`locator is disabled: ${selector}`);
  element.focus();
  const eventOptions = { bubbles: true, cancelable: true, view: window, detail: clickCount };
  element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
  element.dispatchEvent(new MouseEvent("mouseup", eventOptions));
  element.click();
  if (clickCount === 2) element.dispatchEvent(new MouseEvent("dblclick", eventOptions));
}

function pressLocatorSource(selector, value) {
  const element = uniqueElement(selector);
  if (element.disabled) throw new Error(`locator is disabled: ${selector}`);
  element.focus();
  const key = String(value);
  const options = { key, bubbles: true, cancelable: true };
  element.dispatchEvent(new KeyboardEvent("keydown", options));
  element.dispatchEvent(new KeyboardEvent("keypress", options));
  element.dispatchEvent(new KeyboardEvent("keyup", options));
}

function readAllLocatorSource(selector, relativeSelector) {
  const elements = queryLocatorAll(selector);
  return elements.map((element) => {
    const target = relativeSelector == null ? element : queryLocatorAll(relativeSelector, [element])[0] ?? null;
    if (target == null) return null;
    return {
      attributes: allAttributes(target),
      inner_text: target.innerText ?? "",
      text_content: target.textContent,
    };
  });
}

function selectOptionLocatorSource(selector, selections) {
  const element = uniqueElement(selector);
  if (element.disabled) throw new Error(`locator is disabled: ${selector}`);
  if (element.tagName?.toLowerCase() !== "select") throw new Error("selectOption requires a select element: " + selector);
  const select = element;
  const requested = Array.isArray(selections) ? selections : [];
  if (requested.length === 0) throw new Error("selectOption requires at least one selection");
  const matched = new Set();
  for (const selection of requested) {
    const option = Array.from(select.options).find((candidate, index) => {
      if (selection.index != null && Number(selection.index) === index) return true;
      if (selection.value != null && String(selection.value) === candidate.value) return true;
      if (selection.label != null && String(selection.label) === candidate.label) return true;
      return false;
    });
    if (!option) throw new Error("select option was not found");
    matched.add(option);
  }
  for (const option of Array.from(select.options)) option.selected = matched.has(option);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setCheckedLocatorSource(selector, checked) {
  const element = uniqueElement(selector);
  if (element.disabled) throw new Error(`locator is disabled: ${selector}`);
  const tag = element.tagName?.toLowerCase();
  const type = (element.getAttribute("type") || "").toLowerCase();
  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    if (element.checked !== checked) {
      element.checked = checked;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  if (element.getAttribute("role") === "switch" || element.getAttribute("role") === "checkbox") {
    const current = element.getAttribute("aria-checked") === "true";
    if (current !== checked) {
      element.setAttribute("aria-checked", checked ? "true" : "false");
      element.click();
    }
    return;
  }
  throw new Error("setChecked requires a checkbox, radio, or switch-like element: " + selector);
}

function elementInfoSource(x, y, includeNonInteractable) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("elementInfo requires finite x/y");
  return document.elementsFromPoint(x, y)
    .filter((element) => includeNonInteractable || elementVisible(element))
    .slice(0, 20)
    .map((element) => elementInfoValue(element));
}

function installElementScreenshotOverlaySource(x, y, includeNonInteractable) {
  document.getElementById("__codex_iab_element_overlay__")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "__codex_iab_element_overlay__";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483647";
  const point = document.createElement("div");
  point.style.position = "absolute";
  point.style.left = Math.round(x - 5) + "px";
  point.style.top = Math.round(y - 5) + "px";
  point.style.width = "10px";
  point.style.height = "10px";
  point.style.border = "2px solid #ff2d55";
  point.style.borderRadius = "999px";
  point.style.background = "rgba(255,45,85,0.25)";
  overlay.appendChild(point);
  for (const item of elementInfoSource(x, y, includeNonInteractable).slice(0, 8)) {
    const rect = item.boundingBox;
    if (!rect) continue;
    const box = document.createElement("div");
    box.style.position = "absolute";
    box.style.left = Math.round(rect.x) + "px";
    box.style.top = Math.round(rect.y) + "px";
    box.style.width = Math.round(rect.width) + "px";
    box.style.height = Math.round(rect.height) + "px";
    box.style.outline = "2px solid #00d4ff";
    box.style.background = "rgba(0,212,255,0.08)";
    overlay.appendChild(box);
  }
  document.documentElement.appendChild(overlay);
}

function elementInfoValue(element) {
  const rect = element.getBoundingClientRect();
  const selector = selectorForElement(element);
  return {
    nodeId: null,
    tagName: element.tagName.toLowerCase(),
    role: computedRole(element),
    visibleText: elementText(element) || null,
    ariaName: accessibleName(element) || null,
    testId: element.getAttribute("data-testid"),
    boundingBox: rect.width > 0 || rect.height > 0 ? {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    } : null,
    preview: elementPreview(element),
    selector,
  };
}

function selectorForElement(element) {
  const candidates = [];
  if (element.id) candidates.push("#" + cssEscape(element.id));
  const testId = element.getAttribute("data-testid");
  if (testId) candidates.push("[data-testid=\"" + cssStringEscape(testId) + "\"]");
  const name = element.getAttribute("name");
  if (name) candidates.push(element.tagName.toLowerCase() + "[name=\"" + cssStringEscape(name) + "\"]");
  candidates.push(cssPath(element));
  return {
    primary: candidates[0] ?? null,
    candidates,
  };
}

function elementPreview(element) {
  const attrs = [];
  for (const name of ["id", "class", "role", "aria-label", "data-testid", "name", "type", "href"]) {
    const value = element.getAttribute(name);
    if (value) attrs.push(name + "=" + JSON.stringify(value));
  }
  const text = elementText(element);
  return "<" + element.tagName.toLowerCase() + (attrs.length ? " " + attrs.join(" ") : "") + ">" + (text ? " " + text.slice(0, 80) : "");
}

function cssPath(element) {
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += "#" + cssEscape(current.id);
      parts.unshift(part);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\\\" + char);
}

function cssStringEscape(value) {
  return String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\"");
}

const elementInfoHelpersSource = [
  elementInfoValue,
  selectorForElement,
  elementPreview,
  cssPath,
  cssEscape,
  cssStringEscape,
].map((func) => func.toString()).join("\n");

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
