import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, sha256 } from "./lib/files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("Build this Windows runtime on Windows.");
const args = process.argv.slice(2);
if (args.length) throw new Error("Usage: node scripts/build-windows.mjs");
const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(npm)) throw new Error("npm-cli.js not found alongside node.exe.");
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}).`);
}
const source = (path) => join(root, "upstream", path);
for (const repo of ["pi-packages", "pi-permission-packages", "pi-subagents"]) {
  if (!existsSync(source(`${repo}/.git`))) throw new Error(`Missing ${repo}. Clone with --recurse-submodules.`);
}
console.log("Build pi-subagents from the checked-out, pinned submodule.");
run(process.execPath, [npm, "ci", "--no-audit", "--no-fund"], source("pi-subagents"));
run(process.execPath, [npm, "run", "build:pkg"], source("pi-subagents"));
const stage = join(root, ".build", "windows", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(stage, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) cpSync(join(root, "setup/runtime", file), join(stage, file));
run(process.execPath, [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], stage);
const modules = join(stage, "node_modules");
cpSync(source("pi-subagents/dist-pkg"), join(modules, "pi-subagents"), { recursive: true });
const swPath = join(modules, "pi-subagents/src/workflows/structured-workflow-scripts.js");
if (existsSync(swPath)) {
  let sw = readFileSync(swPath, "utf8");
  sw = sw.replace(
    'return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}, task: ${child.taskExpression} }`).join(", ")}])`;',
    'return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}${child.model ? `, model: ${JSON.stringify(child.model)}` : ""}${child.worktree !== undefined ? `, worktree: ${JSON.stringify(child.worktree)}` : ""}${child.cwd ? `, cwd: ${JSON.stringify(child.cwd)}` : ""}, task: ${child.taskExpression} }`).join(", ")}])`;',
  );
  sw = sw.replace(
    'const record = exactFields(item, path, ["agent", "task"], "Each tasks item accepts only agent and task.");\n        const agent = nonEmptyString(record.agent, `${path}.agent`);\n        const task = nonEmptyString(record.task, `${path}.task`);\n        const taskExpression = compileTemplate(task, {\n            path: `${path}.task`,\n            hasOriginalTask: originalTask !== undefined,\n            previous: { unavailable: "tasks items may only use {task}." },\n            outputsUnavailable: "tasks items may only use {task}."\n        });\n        return { key: `task-${index + 1}`, agent, taskExpression };',
    'const record = exactFields(item, path, ["agent", "task", "model", "worktree", "cwd"], "Each tasks item accepts agent, task, model, worktree and cwd.");\n        const agent = nonEmptyString(record.agent, `${path}.agent`);\n        const task = nonEmptyString(record.task, `${path}.task`);\n        const model = record.model === undefined ? undefined : nonEmptyString(record.model, `${path}.model`);\n        const worktree = typeof record.worktree === "boolean" ? record.worktree : undefined;\n        const cwd = record.cwd === undefined ? undefined : nonEmptyString(record.cwd, `${path}.cwd`);\n        const taskExpression = compileTemplate(task, {\n            path: `${path}.task`,\n            hasOriginalTask: originalTask !== undefined,\n            previous: { unavailable: "tasks items may only use {task}." },\n            outputsUnavailable: "tasks items may only use {task}."\n        });\n        return { key: `task-${index + 1}`, agent, model, worktree, cwd, taskExpression };',
  );
  writeFileSync(swPath, sw);
}
cpSync(source("pi-packages/packages/pi-auto-review/src"), join(modules, "@erichll/pi-auto-review/src"), { recursive: true });
cpSync(source("pi-permission-packages/packages/pi-permission-system/src"), join(modules, "@gotgenes/pi-permission-system/src"), { recursive: true });
const app = join(stage, "app");
mkdirSync(app);
const excludes = new Set([".git", "__pycache__", "node_modules", "runtime-path.local.json", "machine.local.json"]);
const filter = (path) => !excludes.has(path.split(/[/\\]/).at(-1));
for (const directory of ["agents", "extensions", "guards", "config", "skills"]) cpSync(join(root, directory), join(app, directory), { recursive: true, filter });
for (const file of ["settings.json", "models.json", "APPEND_SYSTEM.md"]) cpSync(join(root, file), join(app, file));
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: rootPackage.name, version: rootPackage.version, private: true, pi: rootPackage.pi }, null, 2));
const release = { format: 1, platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split(".")[0]) };
writeFileSync(join(stage, "release.json"), JSON.stringify(release, null, 2));
const files = inventory(stage);
const manifest = { ...release, files };
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
if (revision.status !== 0) throw new Error("Cannot identify source checkout revision.");
const pointer = { stage, manifestHash: sha256(join(stage, "manifest.json")), rootRevision: revision.stdout.trim() };
writeFileSync(join(root, ".build/windows-current.json"), JSON.stringify(pointer, null, 2));
console.log(JSON.stringify({ ...pointer, files: files.length }));
