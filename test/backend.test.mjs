import assert from "node:assert/strict";
import test from "node:test";

import { CodexIabBackend } from "../src/backend.mjs";

test("advertises IAB metadata for the current Codex session", () => {
  const backend = new CodexIabBackend({ engine: fakeEngine(), sessionId: "session-1" });
  const info = backend.info();

  assert.equal(info.type, "iab");
  assert.equal(info.metadata.codexSessionId, "session-1");
  assert.equal(info.metadata.codexAppBuildFlavor, "prod");
  assert.equal(info.metadata.implementation, "codex-iab-backend");
});

test("routes direct session methods to the engine", async () => {
  const engine = fakeEngine();
  const backend = new CodexIabBackend({ engine, sessionId: "session-1" });

  assert.deepEqual(await backend.handle("createTab"), { id: 1, url: "about:blank", active: true });
  assert.deepEqual(await backend.handle("getTabs"), [{ id: 1, url: "about:blank", active: true }]);
});

test("routes command payloads to browser operations", async () => {
  const engine = fakeEngine();
  const backend = new CodexIabBackend({ engine, sessionId: "session-1" });

  await backend.handle("executeUnhandledCommand", { type: "create_tab" });
  await backend.handle("executeUnhandledCommand", { type: "navigate_tab_url", tab_id: "1", url: "data:text/html,ok" });
  const screenshot = await backend.handle("executeUnhandledCommand", { type: "tab_screenshot", tab_id: "1" });

  assert.deepEqual(await backend.handle("executeUnhandledCommand", { type: "list_tabs" }), {
    tabs: [{ id: "1", url: "data:text/html,ok", active: true }],
  });
  assert.deepEqual(screenshot, { data: "png-base64" });
});

test("routes locator commands to the engine", async () => {
  const engine = fakeEngine();
  const backend = new CodexIabBackend({ engine, sessionId: "session-1" });

  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_count",
    tab_id: "1",
    selector: "#speed",
  }), { count: 1 });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_fill",
    tab_id: "1",
    selector: "#speed",
    value: "2.5",
    replace: true,
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_click",
    tab_id: "1",
    selector: "#run",
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_dblclick",
    tab_id: "1",
    selector: "#run",
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_press",
    tab_id: "1",
    selector: "#speed",
    value: "Enter",
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_wait_for",
    tab_id: "1",
    selector: "#speed",
    state: "visible",
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_all_text_contents",
    tab_id: "1",
    selector: "button",
  }), { values: ["run"] });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_text_content",
    tab_id: "1",
    selector: "#run",
  }), { value: "run" });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_inner_text",
    tab_id: "1",
    selector: "#run",
  }), { value: "run" });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_get_attribute",
    tab_id: "1",
    selector: "#run",
    name: "id",
  }), { value: "run" });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_is_visible",
    tab_id: "1",
    selector: "#run",
  }), { value: true });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_is_enabled",
    tab_id: "1",
    selector: "#run",
  }), { value: true });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_read_all",
    tab_id: "1",
    selector: "button",
  }), { values: [{ attributes: { id: "run" }, inner_text: "run", text_content: "run" }] });
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_select_option",
    tab_id: "1",
    selector: "#mode",
    selections: [{ value: "dense" }],
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_locator_set_checked",
    tab_id: "1",
    selector: "#grid",
    checked: true,
  }), {});
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_element_info",
    tab_id: "1",
    x: 10,
    y: 20,
  }), [{ tagName: "button", preview: "<button>" }]);
  assert.deepEqual(await backend.handle("executeUnhandledCommand", {
    type: "playwright_element_screenshot",
    tab_id: "1",
    x: 10,
    y: 20,
  }), { data: "element-png-base64" });
  assert.deepEqual(engine.locatorOps, [
    ["count", "1", "#speed"],
    ["fill", "1", "#speed", "2.5"],
    ["click", "1", "#run"],
    ["dblclick", "1", "#run"],
    ["press", "1", "#speed", "Enter"],
    ["waitFor", "1", "#speed", "visible"],
    ["allTextContents", "1", "button"],
    ["textContent", "1", "#run"],
    ["innerText", "1", "#run"],
    ["getAttribute", "1", "#run", "id"],
    ["isVisible", "1", "#run"],
    ["isEnabled", "1", "#run"],
    ["readAll", "1", "button"],
    ["selectOption", "1", "#mode"],
    ["setChecked", "1", "#grid", true],
    ["elementInfo", "1", 10, 20],
    ["elementScreenshot", "1", 10, 20],
  ]);
});

test("returns a useful error for unsupported commands", async () => {
  const backend = new CodexIabBackend({ engine: fakeEngine(), sessionId: "session-1" });

  await assert.rejects(
    () => backend.handle("executeUnhandledCommand", { type: "not_real" }),
    /unsupported command: not_real/,
  );
});

function fakeEngine() {
  const tabs = new Map();
  let nextId = 1;
  let active = null;
  const locatorOps = [];

  const engine = {
    locatorOps,
    async createTab() {
      const id = String(nextId++);
      active = id;
      tabs.set(id, { id, url: "about:blank" });
      return { ...tabs.get(id), active: true };
    },
    async listTabs() {
      return [...tabs.values()].map((tab) => ({ ...tab, active: tab.id === active }));
    },
    async navigateTab(id, url) {
      tabs.get(String(id)).url = url;
      return {};
    },
    async screenshot() {
      return { data: "png-base64" };
    },
    async selectedTab() {
      return active ? { ...tabs.get(active), active: true } : {};
    },
    async locatorCount(id, command) {
      locatorOps.push(["count", id, command.selector]);
      return { count: 1 };
    },
    async locatorFill(id, command) {
      locatorOps.push(["fill", id, command.selector, command.value]);
      return {};
    },
    async locatorClick(id, command) {
      locatorOps.push(["click", id, command.selector]);
      return {};
    },
    async locatorDblClick(id, command) {
      locatorOps.push(["dblclick", id, command.selector]);
      return {};
    },
    async locatorPress(id, command) {
      locatorOps.push(["press", id, command.selector, command.value]);
      return {};
    },
    async locatorWaitFor(id, command) {
      locatorOps.push(["waitFor", id, command.selector, command.state]);
      return {};
    },
    async locatorAllTextContents(id, command) {
      locatorOps.push(["allTextContents", id, command.selector]);
      return { values: ["run"] };
    },
    async locatorTextContent(id, command) {
      locatorOps.push(["textContent", id, command.selector]);
      return { value: "run" };
    },
    async locatorInnerText(id, command) {
      locatorOps.push(["innerText", id, command.selector]);
      return { value: "run" };
    },
    async locatorGetAttribute(id, command) {
      locatorOps.push(["getAttribute", id, command.selector, command.name]);
      return { value: "run" };
    },
    async locatorIsVisible(id, command) {
      locatorOps.push(["isVisible", id, command.selector]);
      return { value: true };
    },
    async locatorIsEnabled(id, command) {
      locatorOps.push(["isEnabled", id, command.selector]);
      return { value: true };
    },
    async locatorReadAll(id, command) {
      locatorOps.push(["readAll", id, command.selector]);
      return { values: [{ attributes: { id: "run" }, inner_text: "run", text_content: "run" }] };
    },
    async locatorSelectOption(id, command) {
      locatorOps.push(["selectOption", id, command.selector]);
      return {};
    },
    async locatorSetChecked(id, command) {
      locatorOps.push(["setChecked", id, command.selector, command.checked]);
      return {};
    },
    async elementInfo(id, command) {
      locatorOps.push(["elementInfo", id, command.x, command.y]);
      return [{ tagName: "button", preview: "<button>" }];
    },
    async elementScreenshot(id, command) {
      locatorOps.push(["elementScreenshot", id, command.x, command.y]);
      return { data: "element-png-base64" };
    },
  };
  return engine;
}
