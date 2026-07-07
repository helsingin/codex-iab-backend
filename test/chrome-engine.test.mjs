import assert from "node:assert/strict";
import test from "node:test";

import { ChromeEngine } from "../src/chrome-engine.mjs";

test("start reconnects an existing browser CDP connection", async () => {
  const engine = new ChromeEngine({ chromePath: "/not-used" });
  let connectCount = 0;
  engine.process = { exitCode: null };
  engine.browserConnection = {
    async connect() {
      connectCount++;
    },
  };

  const result = await engine.start();

  assert.equal(result, engine);
  assert.equal(connectCount, 1);
});
