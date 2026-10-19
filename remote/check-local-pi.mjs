import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const cli = process.argv[2];
if (!cli) throw new Error("Pass the managed Pi CLI path");
const cwd = mkdtempSync(join(tmpdir(), "pitato-local-startup-"));
const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session"], {
  cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const pending = new Map();
let buffered = "";
let stderr = "";
let agentRuns = 0;
const extensionErrors = [];
child.stdout.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  let end;
  while ((end = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "extension_error") extensionErrors.push({ path: event.extensionPath, event: event.event, error: event.error });
    if (event.type === "agent_start") { agentRuns++; child.stdin.write('{"type":"abort"}\n'); }
    if (event.type !== "response") continue;
    const call = pending.get(event.id);
    if (!call) continue;
    pending.delete(event.id); clearTimeout(call.timer);
    if (event.success) call.resolve(event.data); else call.reject(new Error(event.error));
  }
});
function request(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(type); reject(new Error(`Pi ${type} timeout; ${stderr}`)); }, 20000);
    pending.set(type, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: type, type }) + "\n");
  });
}
try {
  const state = await request("get_state");
  const commands = await request("get_commands");
  const models = await request("get_available_models");
  const commandNames = (commands.commands ?? commands).map((command) => command.name);
  const available = models.models ?? models;
  const result = {
    model: state.model && `${state.model.provider}/${state.model.id}`,
    thinking: state.thinkingLevel,
    streaming: state.isStreaming,
    autoCompactionEnabled: state.autoCompactionEnabled,
    permissionCommandLoaded: commandNames.includes("permission-system"),
    reviewerCommandsLoaded: commandNames.includes("auto-review-policy-audit"),
    reviewerModelAvailable: available.some((model) => model.provider === "openai" && model.id === "codex-auto-review"),
    fastCommandLoaded: commandNames.includes("fast"),
    extensionErrors,
    agentRuns,
  };
  assert.equal(result.streaming, false);
  assert.equal(result.permissionCommandLoaded, true, stderr);
  assert.equal(result.reviewerCommandsLoaded, true, stderr);
  assert.equal(result.reviewerModelAvailable, true);
  assert.equal(result.fastCommandLoaded, true);
  assert.deepEqual(extensionErrors, []);
  assert.equal(agentRuns, 0);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  mkdirSync(join(root, "remote/.maintenance"), { recursive: true });
  writeFileSync(join(root, "remote/.maintenance/local-pi-startup.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  child.kill();
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
}
