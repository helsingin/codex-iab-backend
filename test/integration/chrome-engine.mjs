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

  const formTab = await engine.createTab();
  const formHtml = `
    <label for="speed">Speed</label>
    <input id="speed" type="range" min="0" max="8" step="0.25" value="1">
    <label><input id="grid" type="checkbox"> Grid</label>
    <select id="mode"><option value="simple">Simple</option><option value="dense">Dense</option></select>
    <button id="run" data-testid="run-action">run</button>
    <ul id="items"><li data-kind="a">alpha</li><li data-kind="b">beta</li></ul>
    <script>
      window.events = [];
      speed.addEventListener('input', () => events.push('input:' + speed.value));
      speed.addEventListener('change', () => events.push('change:' + speed.value));
      grid.addEventListener('change', () => events.push('grid:' + grid.checked));
      mode.addEventListener('change', () => events.push('mode:' + mode.value));
      run.addEventListener('click', () => events.push('click'));
      run.addEventListener('dblclick', () => events.push('dblclick'));
    </script>
  `;
  await engine.navigateTab(
    formTab.id,
    `data:text/html,${encodeURIComponent(formHtml)}`,
    { timeout_ms: 3000 },
  );
  await engine.waitForLoadState(formTab.id, { state: "load", timeoutMs: 1000 });
  assert.equal((await engine.locatorCount(formTab.id, { selector: "#speed" })).count, 1);
  assert.equal((await engine.locatorCount(formTab.id, { selector: "#missing" })).count, 0);
  assert.equal((await engine.locatorCount(formTab.id, { selector: 'internal:role=button[name="run"s]' })).count, 1);
  assert.equal((await engine.locatorCount(formTab.id, { selector: 'internal:testid=[data-testid="run-action"s]' })).count, 1);
  assert.deepEqual(await engine.locatorAllTextContents(formTab.id, { selector: "#items li" }), { values: ["alpha", "beta"] });
  assert.deepEqual(await engine.locatorTextContent(formTab.id, { selector: "#items li >> nth=0" }), { value: "alpha" });
  assert.deepEqual(await engine.locatorInnerText(formTab.id, { selector: "#items li >> nth=1" }), { value: "beta" });
  assert.deepEqual(await engine.locatorGetAttribute(formTab.id, { selector: "#items li >> nth=1", name: "data-kind" }), { value: "b" });
  assert.deepEqual(await engine.locatorReadAll(formTab.id, { selector: "#items li" }), {
    values: [
      { attributes: { "data-kind": "a" }, inner_text: "alpha", text_content: "alpha" },
      { attributes: { "data-kind": "b" }, inner_text: "beta", text_content: "beta" },
    ],
  });
  assert.deepEqual(await engine.locatorIsVisible(formTab.id, { selector: "#run" }), { value: true });
  assert.deepEqual(await engine.locatorIsEnabled(formTab.id, { selector: "#run" }), { value: true });
  await engine.locatorWaitFor(formTab.id, { selector: 'internal:text="run"s', state: "visible", timeout_ms: 1000 });
  await engine.locatorFill(formTab.id, { selector: "#speed", value: "2.5", timeout_ms: 1000 });
  await engine.locatorFill(formTab.id, { selector: 'internal:label="Speed"s', value: "3.0", timeout_ms: 1000 });
  await engine.locatorSetChecked(formTab.id, { selector: "#grid", checked: true, timeout_ms: 1000 });
  await engine.locatorSelectOption(formTab.id, { selector: "#mode", selections: [{ value: "dense" }], timeout_ms: 1000 });
  await engine.locatorClick(formTab.id, { selector: "#run", timeout_ms: 1000 });
  await engine.locatorDblClick(formTab.id, { selector: "#run", timeout_ms: 1000 });
  const buttonCenter = (await engine.evaluate(formTab.id, "() => { const rect = run.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }")).value;
  const info = await engine.elementInfo(formTab.id, { ...buttonCenter });
  const elementShot = await engine.elementScreenshot(formTab.id, { ...buttonCenter });
  assert.ok(info.some((item) => item.tagName === "button" && item.selector.candidates.some((selector) => selector.includes("run"))));
  assert.ok(elementShot.data.length > 1000);
  await engine.executeCdp({
    target: { tabId: formTab.id },
    method: "Runtime.evaluate",
    params: { expression: "window.__codexPlaywrightInjected = {}; 'ok'", returnByValue: true },
  });
  const ariaSnapshot = await engine.executeCdp({
    target: { tabId: formTab.id },
    method: "Runtime.evaluate",
    params: {
      expression: "window.__codexPlaywrightInjected.incrementalAriaSnapshot(document.body).full",
      returnByValue: true,
    },
  });
  assert.match(ariaSnapshot.result.value, /button "run"/);
  assert.deepEqual(await engine.evaluate(formTab.id, "() => ({ value: speed.value, events })"), {
    value: {
      value: "3",
      events: [
        "input:2.5",
        "change:2.5",
        "input:3",
        "change:3",
        "grid:true",
        "mode:dense",
        "click",
        "click",
        "dblclick",
      ],
    },
  });

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
