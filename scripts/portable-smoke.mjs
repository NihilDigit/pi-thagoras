import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { applyProfile, planProfile } from "./lib/profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = resolve(process.argv[2] ?? JSON.parse(readFileSync(join(root, ".build/windows-current.json"), "utf8")).stage);
const directory = mkdtempSync(join(tmpdir(), "pi-thagoras-fresh-中文 space-"));
const agentDir = join(directory, "agent"), runtimeRoot = join(directory, "runtime"), project = join(directory, "project");
mkdirSync(project);
const temporary = join(directory, "temp"); mkdirSync(temporary);
const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, PI_CODING_AGENT_DIR: agentDir, REMOTE_PI_HOME: join(directory, "remote-home"), PI_THAGORAS_RECOVERY_STATE: join(runtimeRoot, "recovery") };
const port = async () => {
  const server = createServer(); await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const number = server.address().port; await new Promise((done) => server.close(done)); return number;
};
const hostPort = await port();
applyProfile(planProfile({ releaseRoot, agentDir, runtimeRoot, projectPath: project, relayUrl: "ws://127.0.0.1:3017", port: hostPort }));
function run(args, extraEnv = {}, input) {
  const result = spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, input, cwd: project, encoding: "utf8", windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout;
}
const result = { freshProfile: true };
result.startup = JSON.parse(run([join(root, "scripts/doctor.mjs"), "--agent", agentDir]));
const sdkRoot = join(releaseRoot, "node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
const bash = sdk.createBashTool(project);
const shellResult = await bash.execute("portable-shell", { command: "printf 'PORTABLE_BASH_OK'" });
assert.match(shellResult.content.filter((block) => block.type === "text").map((block) => block.text).join(""), /PORTABLE_BASH_OK/);
result.nativeBash = true;
result.controls = JSON.parse(run(["--disable-warning=ExperimentalWarning", "--experimental-transform-types", join(root, "remote/controls-sdk-smoke.mjs"),
  sdkRoot, join(releaseRoot, "node_modules/pi-subagents"), join(directory, "controls.json")]));
result.review = JSON.parse(run([join(root, "remote/review-sdk-smoke.mjs")], {
  PI_REVIEW_SMOKE_CLI: join(sdkRoot, "dist/bundle/cli.js"),
  PI_REVIEW_SMOKE_PERMISSION_ENTRY: join(releaseRoot, "node_modules/@gotgenes/pi-permission-system/src/index.ts"),
  PI_REVIEW_SMOKE_REVIEWER_ENTRY: join(releaseRoot, "node_modules/@erichll/pi-auto-review/src/index.ts"),
  PI_REVIEW_SMOKE_RECEIPT: join(directory, "review.json"),
}));

const fixture = join(directory, "protections.mjs"), protections = join(directory, "protections.json");
const beforeReceipt = join(directory, "protections-before.json");
writeFileSync(fixture, `import {readFileSync,writeFileSync} from 'node:fs';
import {resolveRequiredChildExtensions} from ${JSON.stringify(pathToFileURL(join(releaseRoot, "node_modules/pi-subagents/src/shared/required-child-extensions.js")).href)};
export default function(pi){
pi.registerProvider('portable-no-network',{api:'portable-no-network',baseUrl:'http://127.0.0.1:1',apiKey:'synthetic',models:[{id:'probe',name:'Probe',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:16000,maxTokens:1000}],streamSimple(){throw Error('Unexpected model call');}});
pi.registerCommand('portable-protections-before',{description:'Inspect synthetic protections',handler:async(_args,ctx)=>{const oldId=ctx.sessionManager.getSessionId();writeFileSync(${JSON.stringify(beforeReceipt)},JSON.stringify({oldId,before:resolveRequiredChildExtensions(oldId)}));}});
pi.registerCommand('portable-protections-after',{description:'Inspect synthetic protections after switching',handler:async(_args,ctx)=>{const {oldId,before}=JSON.parse(readFileSync(${JSON.stringify(beforeReceipt)},'utf8'));const newId=ctx.sessionManager.getSessionId();const after=resolveRequiredChildExtensions(newId);writeFileSync(${JSON.stringify(protections)},JSON.stringify({before:before.map(({id,requireForAllRunners})=>({id,requireForAllRunners})),after:after.map(({id,requireForAllRunners})=>({id,requireForAllRunners})),changed:newId!==oldId,oldDetached:resolveRequiredChildExtensions(oldId).length===0}));}});}`);
const probe = spawn(process.execPath, [join(sdkRoot, "dist/bundle/cli.js"), "--mode", "rpc", "--no-session", "--model", "portable-no-network/probe", "-e", fixture], { env, cwd: project, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map(); let buffer = "", probeErrors = "";
probe.stderr.on("data", (data) => { probeErrors += String(data); });
probe.stdout.setEncoding("utf8");
probe.stdout.on("data", (data) => {
  buffer += data; let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "response") pending.get(event.id)?.(event);
  }
});
async function request(type, extra = {}) {
  let timer;
  try {
    return await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error(`Protection probe timeout: ${type}; ${probeErrors}`)), 20000);
      pending.set(type, (event) => event.success ? done(event.data) : reject(new Error(event.error)));
      probe.stdin.write(JSON.stringify({ id: type, type, ...extra }) + "\n");
    });
  } finally { clearTimeout(timer); pending.delete(type); }
}
try {
  const waitFor = async (file) => {
    const deadline = Date.now() + 20000;
    while (!existsSync(file)) { if (Date.now() > deadline) throw new Error(`Protection receipt timed out: ${file}; ${probeErrors}`); await new Promise((done) => setTimeout(done, 20)); }
  };
  await request("get_state");
  await request("prompt", { message: "/portable-protections-before" });
  await waitFor(beforeReceipt);
  await request("new_session");
  await request("prompt", { message: "/portable-protections-after" });
  await waitFor(protections);
} finally { probe.kill(); await new Promise((done) => probe.exitCode !== null ? done() : probe.once("exit", done)); }
assert.ok(existsSync(protections), probeErrors);
const lifecycle = JSON.parse(readFileSync(protections, "utf8"));
result.protections = lifecycle.after;
assert.deepEqual(result.protections.map((entry) => entry.id), ["pi-thagoras-recovery", "pi-permission-system", "pi-auto-review"]);
assert.ok(result.protections.every((entry) => entry.requireForAllRunners));
assert.equal(lifecycle.changed, true); assert.equal(lifecycle.oldDetached, true);
result.sessionSwitchProtected = true;

// The loopback host test has no relay URL, so it creates no real identity or pairing.
const hostPath = join(runtimeRoot, "pitato/host.json");
const hostConfig = JSON.parse(readFileSync(hostPath, "utf8")); delete hostConfig.relayUrl;
writeFileSync(hostPath, JSON.stringify(hostConfig));
const host = spawn(process.execPath, [join(releaseRoot, "app/remote/run-host.mjs"), "--config", hostPath], { env, cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let hostOutput = "";
host.stdout.on("data", (data) => { hostOutput += String(data); });
host.stderr.on("data", (data) => { hostOutput += String(data); });
async function api(command) {
  const response = await fetch(`http://127.0.0.1:${hostPort}/api`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pitato-Local": "1" }, body: JSON.stringify(command), signal: AbortSignal.timeout(20000) });
  const data = await response.json(); assert.equal(data.ok, true, JSON.stringify(data)); return data.data;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${hostPort}/`)).ok) { ready = true; break; } } catch {}
    if (host.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, `isolated host did not start: ${hostOutput}`);
  const description = await api({ action: "describe" });
  const created = await api({ action: "create", projectId: "primary", generation: description.generation, operationId: randomUUID() });
  assert.ok(created.lease, JSON.stringify(created));
  const connection = await api({ action: "connect", binding: created.lease });
  const snapshot = await api({ action: "snapshot", connection });
  assert.ok(Array.isArray(snapshot.messages));
  await api({ action: "stop", connection });
  result.host = { startup: true, realPiRpcSession: true, snapshot: true, stopped: true, prompts: 0 };
} finally {
  host.kill(); await new Promise((done) => host.exitCode !== null ? done() : host.once("exit", done));
}

if (process.platform === "win32") {
  const keyring = await import(pathToFileURL(join(releaseRoot, "node_modules/@napi-rs/keyring/index.js")).href);
  const entry = new keyring.Entry("pi-thagoras-portable-smoke", randomUUID());
  const value = "synthetic-" + randomUUID();
  try { entry.setPassword(value); assert.equal(entry.getPassword(), value); result.keyring = true; }
  finally { entry.deletePassword(); }
}
const manifest = JSON.parse(readFileSync(join(releaseRoot, "release.json"), "utf8"));
if (manifest.software) {
  const relayPort = await port();
  const relay = spawn(join(releaseRoot, "tools/relay.exe"), [], { env: { ...env, REMOTEPI_RELAY_PORT: String(relayPort), REMOTEPI_MESH_DB_PATH: join(directory, "synthetic-mesh.db"), RUST_LOG: "warn" }, stdio: "ignore", windowsHide: true });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await (await fetch(`http://127.0.0.1:${relayPort}/health`)).text()).trim() === "OK") { ready = true; break; } } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(ready, "isolated relay did not start"); result.relay = { health: true, port: relayPort };
  } finally { relay.kill(); await new Promise((done) => relay.exitCode !== null ? done() : relay.once("exit", done)); }
}
result.externalModelCalls = 0;
writeFileSync(join(root, ".build/portable-smoke.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
