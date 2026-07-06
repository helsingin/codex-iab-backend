import assert from "node:assert/strict";

import { ChromeEngine } from "../../src/chrome-engine.mjs";

const engine = new ChromeEngine({ headless: true });

try {
  await engine.start();
  const tab = await engine.createTab();
  await engine.navigateTab(tab.id, "data:text/html,<title>IAB Test</title><main>ready</main>");
  const tabs = await engine.listTabs();
  const snapshot = await engine.domSnapshot(tab.id);
  const screenshot = await engine.screenshot(tab.id);

  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, "IAB Test");
  assert.match(snapshot.dom_snapshot, /ready/);
  assert.ok(screenshot.data.length > 1000);

  console.log("chrome engine integration ok");
} finally {
  await engine.stop();
}
