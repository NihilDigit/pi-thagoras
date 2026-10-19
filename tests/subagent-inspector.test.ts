import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserInspector } from "../extensions/subagent-inspector/server.ts";

test("browser inspector shows only the selected run and closes without stopping it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitato-inspector-"));
  const statusPath = join(directory, "status.json");
  const original = JSON.stringify({ runId: "synthetic-run", state: "running", steps: [] });
  writeFileSync(statusPath, original);
  const opened: string[] = [];
  const inspector = createBrowserInspector({ openBrowser: async (url) => { opened.push(url); },
    dashboard(input) {
      assert.equal(input.asyncDir, directory);
      assert.deepEqual(input.sessionRoots, [directory]);
      assert.equal(input.allowSteer, false);
      assert.equal(input.allowStop, false);
      return "\u001b[31m合成输出 <script>unsafe()</script>\u001b[0m";
    },
  });
  const context = { target: { runId: "synthetic-run", asyncDir: directory, status: { state: "running" } } };
  const launch = { executable: process.execPath, argv: ["inspector-runner.mjs"], sessionRoots: [directory], allowSteer: true, allowStop: true };
  try {
    await inspector.plugin.open(context, launch, {});
    assert.equal(inspector.plugin.owns(context), true);
    assert.equal(opened.length, 1);
    const url = opened[0]!;
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /textContent=snapshot.text/);
    const snapshot = await fetch(`${url}?snapshot=1`);
    assert.deepEqual(await snapshot.json(), { state: "running", text: "合成输出 <script>unsafe()</script>" });
    await inspector.plugin.open(context, launch, {});
    assert.equal(opened.length, 1, "opening the same binding does not create a second page");
    assert.equal((await fetch(`${url}?snapshot=1`, { headers: { Origin: "https://outside.invalid" } })).status, 403);
    assert.equal((await fetch(url, { method: "POST" })).status, 403);
    assert.equal((await fetch(new URL("/wrong-token", url))).status, 404);
    writeFileSync(statusPath, JSON.stringify({ runId: "other-run", state: "running" }));
    assert.equal((await fetch(`${url}?snapshot=1`)).status, 503);
    writeFileSync(statusPath, original);
    await inspector.plugin.close(context);
    assert.equal(inspector.plugin.owns(context), false);
    assert.equal((await fetch(url)).status, 410);
    assert.equal(readFileSync(statusPath, "utf8"), original);
    assert.deepEqual(readdirSync(directory), ["status.json"]);
  } finally { inspector.close(); }
});

test("an explicitly unfocused inspector provides a link without opening a browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitato-inspector-focus-"));
  writeFileSync(join(directory, "status.json"), JSON.stringify({ runId: "run", state: "complete" }));
  let opens = 0;
  const inspector = createBrowserInspector({ openBrowser: async () => { opens++; }, dashboard: () => "Complete" });
  const context = { target: { runId: "run", asyncDir: directory, status: { state: "complete" } } };
  const launch = { executable: process.execPath, argv: ["inspector-runner.mjs"], sessionRoots: [], allowSteer: false, allowStop: false };
  try {
    const result = await inspector.plugin.open(context, launch, { focus: false });
    assert.match(result.content[0]!.text, /http:\/\/127\.0\.0\.1:/);
    assert.equal(opens, 0);
    await inspector.plugin.open(context, launch, { focus: true });
    assert.equal(opens, 1);
  } finally { inspector.close(); }
});
