import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import registerInspector from "../extensions/subagent-inspector.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = process.argv[2] ?? join(root, "upstream/pi-subagents");
const base = join(packageRoot, "src/inspectors/plugins");
const module = await import(pathToFileURL(`${base}.${existsSync(`${base}.js`) ? "js" : "ts"}`).href);
const events = new EventEmitter();
const callbacks = new Map();
const notices = [];
const pi = {
  events: { emit: (...args) => events.emit(...args), on(name, callback) { events.on(name, callback); return () => events.off(name, callback); } },
  on(name, callback) { callbacks.set(name, callback); },
};
const release = module.registerInspectorEventListener(pi);
try {
  registerInspector(pi);
  await callbacks.get("session_start")({}, { ui: { notify(message) { notices.push(message); } } });
  const plugins = module.getInspectorPlugins(pi);
  const browser = plugins.find((plugin) => plugin.name === "pitato-browser");
  assert.ok(browser, "root extension must register with the installed native inspector owner");
  assert.equal(await browser.available({}), true);
  assert.deepEqual(notices, []);
  await callbacks.get("session_shutdown")();
  assert.equal(module.getInspectorPlugins(pi).some((plugin) => plugin.name === "pitato-browser"), false);
  const result = { nativeRegistration: true, browserAvailable: true, disposedOnShutdown: true, modelCalls: 0 };
  mkdirSync(join(root, "remote/.maintenance"), { recursive: true });
  writeFileSync(join(root, "remote/.maintenance/inspector-registration-smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { release(); }
