import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planProfile, applyProfile } from "../scripts/lib/profile.mjs";
import { patchSubagentsFiles } from "../scripts/lib/optimize-release.mjs";
import { installedPackageRoot } from "../guards/installed-paths.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-portable-中文 space-"));
  const releaseRoot = join(directory, "release"), app = join(releaseRoot, "app");
  mkdirSync(join(app, "config"), { recursive: true });
  writeFileSync(join(app, "settings.json"), JSON.stringify({ defaultProvider: "cliproxyapi", defaultModel: "gemini-4-argon-high", subagents: { disableBuiltins: true } }));
  writeFileSync(join(app, "models.json"), JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-6-astra": { contextWindow: 1000000 } } } } }));
  writeFileSync(join(app, "APPEND_SYSTEM.md"), "Role instructions.");
  writeFileSync(join(app, "config/permissions.json"), JSON.stringify({ authorizerChain: ["pi-auto-review"], permission: { "*": "ask", path: { "*.key": "deny" } } }));
  writeFileSync(join(releaseRoot, "release.json"), JSON.stringify({ format: 1 }));
  const options = { releaseRoot, agentDir: join(directory, "profile"), runtimeRoot: join(directory, "state") };
  return { ...options, options, directory };
}

test("fresh profile uses only target paths and retains credentials and unrelated preferences", () => {
  const f = fixture(); mkdirSync(f.agentDir);
  writeFileSync(join(f.agentDir, "auth.json"), "synthetic-auth-do-not-copy");
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ theme: "custom", defaultModel: "my-model", packages: ["npm:unrelated@1.0.0"] }));
  const plan = planProfile(f.options);
  assert.equal(existsSync(join(f.agentDir, "pi-thagoras.json")), false, "planning must not write");
  applyProfile(plan);
  const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
  assert.equal(settings.theme, "custom"); assert.equal(settings.defaultModel, "my-model");
  assert.ok(settings.packages.includes("npm:unrelated@1.0.0"));
  assert.equal(settings.subagents.defaultSubagentOnlyExtensions[0], join(f.agentDir, "extensions/local-guards.ts"));
  assert.equal(readFileSync(join(f.agentDir, "auth.json"), "utf8"), "synthetic-auth-do-not-copy");
  assert.equal([...plan.files.keys()].some((path) => path.endsWith("auth.json")), false);
  assert.match(readFileSync(join(f.agentDir, "extensions/local-guards.ts"), "utf8"), /createRecoveryHost/);
});

test("reapplying setup does not duplicate packages, guards or role instructions", () => {
  const f = fixture(); applyProfile(planProfile(f.options)); applyProfile(planProfile(f.options));
  const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
  assert.equal(new Set(settings.packages).size, settings.packages.length);
  assert.equal(new Set(settings.subagents.defaultSubagentOnlyExtensions).size, 3);
  assert.equal(readFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "utf8").split("Role instructions.").length, 2);
});

test("foreign guard and unreviewed authorizer policy block configuration before writing", () => {
  const f = fixture(); mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(f.agentDir, "extensions/local-guards.ts"), "foreign guard");
  assert.throws(() => planProfile(f.options), /not owned/);
  assert.equal(existsSync(join(f.agentDir, "settings.json")), false);
  const other = fixture(); mkdirSync(join(other.agentDir, "extensions/pi-permission-system"), { recursive: true });
  writeFileSync(join(other.agentDir, "extensions/pi-permission-system/config.json"), JSON.stringify({ authorizerChain: ["other"] }));
  assert.throws(() => planProfile(other.options), /authorizer chain/);
});

test("guard resolution uses the target profile rather than another machine", () => {
  const f = fixture(); applyProfile(planProfile(f.options));
  const modules = join(f.releaseRoot, "node_modules");
  for (const name of ["@erichll/pi-auto-review", "pi-subagents"]) {
    mkdirSync(join(modules, name), { recursive: true }); writeFileSync(join(modules, name, "package.json"), JSON.stringify({ name }));
    assert.equal(installedPackageRoot(f.agentDir, name), join(modules, name));
  }
});

test("a staging failure preserves existing settings and leaves no active partial profile", () => {
  const f = fixture(); mkdirSync(f.agentDir);
  const settingsPath = join(f.agentDir, "settings.json");
  const original = JSON.stringify({ theme: "keep" }); writeFileSync(settingsPath, original);
  const blocker = join(f.directory, "not-a-directory"); writeFileSync(blocker, "keep");
  const plan = planProfile(f.options); plan.files.set(join(blocker, "invalid.json"), "{}");
  assert.throws(() => applyProfile(plan));
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  assert.equal(existsSync(join(f.agentDir, "pi-thagoras.json")), false);
  assert.equal(existsSync(join(f.agentDir, "extensions/local-guards.ts")), false);
});

test("private runtime data cannot be placed in a source checkout or installed release", () => {
  const f = fixture();
  assert.throws(() => planProfile({ ...f.options, runtimeRoot: join(f.options.releaseRoot, "state") }), /must stay outside/);
  assert.throws(() => planProfile({ ...f.options, checkoutRoot: f.directory }), /must stay outside/);
});

test("patchSubagentsFiles enables model/worktree/cwd in parallel tasks and updates delegation guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-patch-"));
  mkdirSync(join(dir, "src/workflows"), { recursive: true });
  mkdirSync(join(dir, "src/extension"), { recursive: true });
  const swSample = [
    "function runsAllCall(children) {",
    '    return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}, task: ${child.taskExpression} }`).join(", ")}])`;',
    "}",
    "export function sample(item, path, index, originalTask) {",
    '        const record = exactFields(item, path, ["agent", "task"], "Each tasks item accepts only agent and task.");',
    "        const agent = nonEmptyString(record.agent, `${path}.agent`);",
    "        const task = nonEmptyString(record.task, `${path}.task`);",
    "        const taskExpression = compileTemplate(task, {",
    "            path: `${path}.task`,",
    "            hasOriginalTask: originalTask !== undefined,",
    '            previous: { unavailable: "tasks items may only use {task}." },',
    '            outputsUnavailable: "tasks items may only use {task}.",',
    "        });",
    "        return { key: `task-${index + 1}`, agent, taskExpression };",
    "}",
  ].join("\n");
  const tdSample = [
    "export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:",
    "- Delegate only when the operator asked, directly or through applicable user/project instructions; size, complexity or risk alone is not authorization.",
    "- Native async completion wakes this session: return control; do not sleep, poll or call bg_wait for it.`;",
  ].join("\n");
  writeFileSync(join(dir, "src/workflows/structured-workflow-scripts.js"), swSample);
  writeFileSync(join(dir, "src/extension/tool-description.js"), tdSample);
  patchSubagentsFiles(dir);
  const swPatched = readFileSync(join(dir, "src/workflows/structured-workflow-scripts.js"), "utf8");
  const tdPatched = readFileSync(join(dir, "src/extension/tool-description.js"), "utf8");
  assert.match(swPatched, /\["agent", "task", "model", "worktree", "cwd"\]/);
  assert.match(swPatched, /child\.model \?/);
  assert.match(tdPatched, /Delegate proactively per project workflow instructions/);
});
