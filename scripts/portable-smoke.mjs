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
const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, PI_CODING_AGENT_DIR: agentDir, PI_THAGORAS_RECOVERY_STATE: join(runtimeRoot, "recovery") };
applyProfile(planProfile({ releaseRoot, agentDir, runtimeRoot }));
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

if (process.platform === "win32") {
  const keyring = await import(pathToFileURL(join(releaseRoot, "node_modules/@napi-rs/keyring/index.js")).href);
  const entry = new keyring.Entry("pi-thagoras-portable-smoke", randomUUID());
  const value = "synthetic-" + randomUUID();
  try { entry.setPassword(value); assert.equal(entry.getPassword(), value); result.keyring = true; }
  finally { entry.deletePassword(); }
}
result.externalModelCalls = 0;
writeFileSync(join(root, ".build/portable-smoke.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
