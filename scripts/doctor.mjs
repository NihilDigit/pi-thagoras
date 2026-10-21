import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "./lib/files.mjs";

const args = process.argv.slice(2);
let agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
let full = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--agent") agentDir = resolve(args[++index]);
  else if (args[index] === "--full") full = true;
  else throw new Error("Usage: node scripts/doctor.mjs [--agent <directory>] [--full]");
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const infoPath = join(agentDir, "pi-thagoras.json");
if (!existsSync(infoPath)) throw new Error("No generated machine profile. Run setup.ps1 first.");
const info = read(infoPath), modules = join(info.releaseRoot, "node_modules");
const settings = read(join(agentDir, "settings.json"));
const mandatory = [join(agentDir, "extensions/local-guards.ts"), join(modules, "@gotgenes/pi-permission-system/src/index.ts"), join(modules, "@erichll/pi-auto-review/src/index.ts")];
for (const entry of mandatory) {
  if (!existsSync(entry) || !settings.subagents?.defaultSubagentOnlyExtensions?.includes(entry)) throw new Error("Required child protection is missing from the generated profile.");
}
if (settings.subagents.defaultSubagentOnlyExtensions[0] !== mandatory[0]) throw new Error("Recovery guard must load before permission review.");
const policy = read(join(agentDir, "extensions/pi-permission-system/config.json"));
if (!policy.authorizerChain?.includes("pi-auto-review")) throw new Error("Permission policy does not use pi-auto-review.");
const definitions = read(join(agentDir, "models.json"));
if (!definitions.providers?.openai?.models?.some((model) => model.id === "codex-auto-review")) throw new Error("The reviewer model definition is missing. Reapply setup.");
const release = read(join(info.releaseRoot, "release.json"));
if (release.platform !== process.platform || release.arch !== process.arch || Number(process.versions.node.split(".")[0]) !== release.nodeMajor) throw new Error("Runtime platform, ABI or Node major mismatch.");
let verified = 0;
if (full) {
  const manifest = read(join(info.releaseRoot, "manifest.json"));
  for (const file of manifest.files) {
    if (sha256(join(info.releaseRoot, file.path)) !== file.sha256) throw new Error(`Release file changed: ${file.path}`);
    verified++;
  }
}
const child = spawn(process.execPath, [info.piCli, "--mode", "rpc", "--no-session"], {
  cwd: mkdtempSync(join(tmpdir(), "pi-thagoras-doctor-")), env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_THAGORAS_RECOVERY_STATE: info.recoveryState }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
let buffer = "", stderr = "", agentRuns = 0;
const errors = [], responses = new Map(), pending = new Map();
let rejectStartup;
const failure = new Promise((_, reject) => { rejectStartup = reject; });
child.once("error", rejectStartup);
child.once("exit", (code) => { if (pending.size) rejectStartup(new Error(`Pi exited before startup completed (${code}).`)); });
child.stderr.on("data", (data) => { stderr += String(data); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "extension_error") errors.push(event.error);
    if (event.type === "agent_start") { agentRuns++; child.stdin.write('{"type":"abort"}\n'); }
    if (event.type === "response") {
      responses.set(event.id, event);
      pending.get(event.id)?.(event); pending.delete(event.id);
    }
  }
});
async function request(type) {
  const result = new Promise((resolve) => pending.set(type, resolve));
  child.stdin.write(JSON.stringify({ id: type, type }) + "\n");
  const event = await Promise.race([result, failure]);
  if (!event.success) throw new Error(event.error);
  return event.data;
}
const deadline = setTimeout(() => rejectStartup(new Error("Pi startup timed out. Check the generated settings and extension paths.")), 30000);
try {
  const state = await request("get_state");
  const commands = await request("get_commands");
  const names = (commands.commands ?? commands).map((command) => command.name);
  if (errors.length) throw new Error(`Extension startup failed: ${errors.join("; ")}`);
  for (const command of ["fast", "permission-system", "auto-review-policy-audit"]) if (!names.includes(command)) throw new Error(`Command did not load: ${command}`);
  if (agentRuns) throw new Error("Startup unexpectedly triggered a model run.");
  console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, piVersion: info.piVersion,
    model: `${settings.defaultProvider}/${settings.defaultModel}`, needsLogin: !state.model || state.model.provider === "unknown", requiredChildProtections: true,
    permissionReview: true, extensionErrors: 0, filesVerified: verified, modelRuns: agentRuns,
    login: "Run pi-thagoras /login openai if this is a new machine." }, null, 2));
} finally {
  clearTimeout(deadline); child.kill();
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
}
