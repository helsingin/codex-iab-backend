import assert from "node:assert/strict";

import { ChromeEngine } from "../../src/chrome-engine.mjs";

const engine = new ChromeEngine({ headless: true });

try {
  await engine.start();
  const tab = await engine.createTab();
  const cdpEvents = [];
  engine.on("cdpEvent", (event) => cdpEvents.push(event));
  await engine.navigateTab(
    tab.id,
    "data:text/html,<title>IAB Test</title><script>window.__iabGlobalProbe={answer:42}</script><main>ready</main>",
    { timeout_ms: 3000 },
  );
  await engine.waitForLoadState(tab.id, { state: "domcontentloaded", timeoutMs: 1000 });
  await engine.waitForLoadState(tab.id, { state: "load", timeoutMs: 1000 });
  const tabs = await engine.listTabs();
  const snapshot = await engine.domSnapshot(tab.id);
  const screenshot = await engine.screenshot(tab.id);

  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, "IAB Test");
  assert.ok(cdpEvents.some((event) => event.method === "Page.loadEventFired" && event.source.tabId === Number(tab.id)));
  assert.match(snapshot.dom_snapshot, /ready/);
  assert.ok(screenshot.data.length > 1000);
  assert.deepEqual(await engine.evaluate(tab.id, "window.__iabGlobalProbe"), { value: { answer: 42 } });
  assert.deepEqual(await engine.evaluate(tab.id, "() => window.__iabGlobalProbe.answer"), { value: 42 });
  assert.deepEqual(await engine.evaluate(tab.id, "(() => window.__iabGlobalProbe.answer)()"), { value: 42 });
  assert.deepEqual(await engine.evaluate(tab.id, "return window.__iabGlobalProbe.answer;"), { value: 42 });

  const busyUrl = "data:text/html,<title>Busy Tab</title><script>while(true){}</script>";
  const busyTab = await engine.createTab(busyUrl);
  const busyTabs = await Promise.race([
    engine.listTabs(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("listTabs timed out for busy tab")), 2500)),
  ]);

  assert.ok(busyTabs.some((item) => item.id === busyTab.id));

  console.log("chrome engine integration ok");
} finally {
  await engine.stop();
}
