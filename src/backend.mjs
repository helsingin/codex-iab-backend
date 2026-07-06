import os from "node:os";
import { EventEmitter } from "node:events";

export class CodexIabBackend extends EventEmitter {
  constructor({
    buildFlavor = "prod",
    engine,
    metadata = {},
    name = "Local IAB Backend",
    sessionId,
  }) {
    super();
    if (!sessionId) throw new Error("sessionId is required");
    if (!engine) throw new Error("engine is required");
    this.buildFlavor = buildFlavor;
    this.engine = engine;
    this.metadata = metadata;
    this.name = name;
    this.sessionId = sessionId;
    this.sessionName = null;
    this.engine.on?.("cdpEvent", (event) => this.emit("notification", { method: "onCDPEvent", params: event }));
    this.engine.on?.("cdpDetach", (source) => this.emit("notification", { method: "onCDPDetach", params: source }));
  }

  info() {
    return {
      type: "iab",
      name: this.name,
      metadata: {
        codexSessionId: this.sessionId,
        codexAppBuildFlavor: this.buildFlavor,
        host: os.hostname(),
        implementation: "codex-iab-backend",
        ...this.metadata,
      },
      capabilities: {
        browser: [],
        tab: [],
      },
    };
  }

  async handle(method, params = {}) {
    switch (method) {
      case "ping":
        return "pong";
      case "getInfo":
        return this.info();
      case "getTabs":
      case "getUserTabs":
        return (await this.engine.listTabs()).map(directTabInfo);
      case "createTab":
        return directTabInfo(await this.engine.createTab());
      case "attach":
      case "detach":
      case "attachTarget":
      case "detachTarget":
        return {};
      case "executeCdp":
        return await this.engine.executeCdp(params);
      case "allowDownload":
        return {};
      case "claimUserTab":
        return directTabInfo(await this.engine.getPage(params.tabId).info());
      case "getUserHistory":
        return [];
      case "finalizeTabs":
      case "markTab":
        return {};
      case "nameSession":
        this.sessionName = params.name ?? null;
        return {};
      case "executeUnhandledCommand":
        return await this.handleCommand(params);
      case "moveMouse":
        return {};
      default:
        throw new Error(`unsupported method: ${method}`);
    }
  }

  async handleCommand(command = {}) {
    switch (command.type) {
      case "runtime_config":
        return {};
      case "name_session":
        this.sessionName = command.name ?? null;
        return {};
      case "create_tab":
        return commandTabInfo(await this.engine.createTab());
      case "close_tab":
        return await this.engine.closeTab(command.tab_id);
      case "selected_tab":
        return commandTabInfo(await this.engine.selectedTab());
      case "list_tabs":
        return { tabs: (await this.engine.listTabs()).map(commandTabInfo) };
      case "browser_user_open_tabs":
        return { tabs: (await this.engine.listTabs()).map(commandTabInfo) };
      case "browser_user_history":
        return { items: [] };
      case "browser_user_claim_tab":
        return commandTabInfo(await this.engine.getPage(command.tab_id).info());
      case "finalize_tabs":
      case "mark_tab":
        return {};
      case "tabs_content":
        return await this.engine.tabsContent(command);
      case "navigate_tab_url":
        return await this.engine.navigateTab(command.tab_id, command.url, command);
      case "navigate_tab_back":
        return await this.engine.back(command.tab_id);
      case "navigate_tab_forward":
        return await this.engine.forward(command.tab_id);
      case "navigate_tab_reload":
        return await this.engine.reload(command.tab_id);
      case "tab_screenshot":
        return await this.engine.screenshot(command.tab_id, command);
      case "playwright_evaluate":
        return await this.engine.evaluate(command.tab_id, command.script, command);
      case "playwright_dom_snapshot":
        return await this.engine.domSnapshot(command.tab_id);
      case "playwright_locator_count":
        return await this.engine.locatorCount(command.tab_id, command);
      case "playwright_locator_fill":
        return await this.engine.locatorFill(command.tab_id, command);
      case "playwright_locator_click":
        return await this.engine.locatorClick(command.tab_id, command);
      case "playwright_locator_dblclick":
        return await this.engine.locatorDblClick(command.tab_id, command);
      case "playwright_locator_press":
        return await this.engine.locatorPress(command.tab_id, command);
      case "playwright_locator_wait_for":
        return await this.engine.locatorWaitFor(command.tab_id, command);
      case "playwright_locator_all_text_contents":
        return await this.engine.locatorAllTextContents(command.tab_id, command);
      case "playwright_locator_text_content":
        return await this.engine.locatorTextContent(command.tab_id, command);
      case "playwright_locator_inner_text":
        return await this.engine.locatorInnerText(command.tab_id, command);
      case "playwright_locator_get_attribute":
        return await this.engine.locatorGetAttribute(command.tab_id, command);
      case "playwright_locator_is_visible":
        return await this.engine.locatorIsVisible(command.tab_id, command);
      case "playwright_locator_is_enabled":
        return await this.engine.locatorIsEnabled(command.tab_id, command);
      case "playwright_locator_read_all":
        return await this.engine.locatorReadAll(command.tab_id, command);
      case "playwright_locator_select_option":
        return await this.engine.locatorSelectOption(command.tab_id, command);
      case "playwright_locator_set_checked":
        return await this.engine.locatorSetChecked(command.tab_id, command);
      case "playwright_element_info":
        return await this.engine.elementInfo(command.tab_id, command);
      case "playwright_element_screenshot":
        return await this.engine.elementScreenshot(command.tab_id, command);
      case "playwright_wait_for_load_state":
        return await this.engine.waitForLoadState(command.tab_id, command);
      case "playwright_wait_for_url":
        return await this.engine.waitForUrl(command.tab_id, command);
      case "playwright_wait_for_timeout":
        return await this.engine.waitForTimeout(command.tab_id, command.timeout_ms ?? 0);
      case "tab_get_js_dialog":
        return {};
      default:
        throw new Error(`unsupported command: ${command.type}`);
    }
  }
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: 1,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function directTabInfo(tab) {
  if (!tab || typeof tab !== "object") return tab;
  const numericId = Number(tab.id);
  if (!Number.isInteger(numericId) || numericId <= 0) return tab;
  return { ...tab, id: numericId };
}

function commandTabInfo(tab) {
  if (!tab || typeof tab !== "object" || tab.id == null) return tab;
  return { ...tab, id: String(tab.id) };
}
