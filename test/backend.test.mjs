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

  assert.deepEqual(await backend.handle("createTab"), { id: "1", url: "about:blank", active: true });
  assert.deepEqual(await backend.handle("getTabs"), [{ id: "1", url: "about:blank", active: true }]);
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

  return {
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
  };
}
