import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, sha256 } from "./lib/files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("Build this Windows runtime on Windows for the target ABI.");
if (Number(process.versions.node.split(".")[0]) !== 24 || Number(process.versions.node.split(".")[1]) < 19) throw new Error("Use Node.js 24.19 or newer within the 24.x release line.");
const includeRelay = process.argv.includes("--relay-server");
const args = process.argv.slice(2).filter((arg) => arg !== "--relay-server");
if (args.length) throw new Error("Usage: node scripts/build-windows.mjs [--relay-server]");
const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(npm)) throw new Error("Use the official Node.js 24 installation, including npm.");
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}).`);
}
const source = (path) => join(root, "upstream", path);
for (const repo of ["pi-packages", "pi-permission-packages", "pi-subagents", "remote_pi"]) {
  if (!existsSync(source(`${repo}/.git`))) throw new Error(`Missing ${repo}. Clone with --recurse-submodules.`);
}
console.log("Build pi-subagents and remote-pi from the checked-out, pinned submodules.");
run(process.execPath, [npm, "ci", "--no-audit", "--no-fund"], source("pi-subagents"));
run(process.execPath, [npm, "run", "build:pkg"], source("pi-subagents"));
// pnpm's standalone Windows executable avoids cmd.exe argument expansion.
let pnpmExe = spawnSync("where.exe", ["pnpm.exe"], { encoding: "utf8", windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
if (pnpmExe && spawnSync(pnpmExe, ["--version"], { encoding: "utf8", windowsHide: true }).stdout?.trim() !== "11.25.0") pnpmExe = undefined;
const pnpmJs = join(root, ".build", "toolchain", "node_modules", "pnpm", "bin", "pnpm.cjs");
if (!pnpmExe) {
  const toolchain = join(root, ".build", "toolchain");
  mkdirSync(toolchain, { recursive: true });
  run(process.execPath, [npm, "install", "--prefix", toolchain, "--no-audit", "--no-fund", "pnpm@11.25.0"]);
}
const runPnpm = (args, cwd) => pnpmExe ? run(pnpmExe, args, cwd) : run(process.execPath, [pnpmJs, ...args], cwd);
runPnpm(["install", "--frozen-lockfile"], source("remote_pi/pi-extension"));
runPnpm(["build"], source("remote_pi/pi-extension"));
const stage = join(root, ".build", "windows", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(stage, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) cpSync(join(root, "setup/runtime", file), join(stage, file));
run(process.execPath, [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], stage);
const modules = join(stage, "node_modules");
cpSync(source("pi-subagents/dist-pkg"), join(modules, "pi-subagents"), { recursive: true });
cpSync(source("pi-packages/packages/pi-auto-review/src"), join(modules, "@erichll/pi-auto-review/src"), { recursive: true });
cpSync(source("pi-permission-packages/packages/pi-permission-system/src"), join(modules, "@gotgenes/pi-permission-system/src"), { recursive: true });
cpSync(source("remote_pi/pi-extension/dist"), join(modules, "remote-pi/dist"), { recursive: true });
const app = join(stage, "app");
mkdirSync(app);
const excludes = new Set([".git", "__pycache__", "node_modules", "runtime-path.local.json", "machine.local.json"]);
const filter = (path) => !excludes.has(path.split(/[/\\]/).at(-1));
for (const directory of ["agents", "extensions", "guards", "config"]) cpSync(join(root, directory), join(app, directory), { recursive: true, filter });
for (const file of ["settings.json", "models.json", "APPEND_SYSTEM.md"]) cpSync(join(root, file), join(app, file));
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: rootPackage.name, version: rootPackage.version, private: true, pi: rootPackage.pi }, null, 2));
mkdirSync(join(app, "remote"));
for (const file of ["runtime-config.mjs", "runtime-config.ps1", "host-runtime.ps1", "start-host.ps1", "run-host.ps1", "run-host.mjs", "start-pi.ps1", "enable-login-start.ps1", "start-relay.ps1", "connect-tunnel.ps1", "save-tunnel-token.ps1", "versions.json", "Start pitato.cmd"]) cpSync(join(root, "remote", file), join(app, "remote", file));
if (includeRelay) {
  if (process.arch !== "x64") throw new Error("The pinned cloudflared binary is Windows x64; build Host without --relay-server on other architectures.");
  run("cargo.exe", ["build", "--release", "--locked"], source("remote_pi/relay"));
  mkdirSync(join(stage, "tools"));
  cpSync(source("remote_pi/relay/target/release/relay.exe"), join(stage, "tools/relay.exe"));
  const versions = JSON.parse(readFileSync(join(root, "remote/versions.json"), "utf8"));
  const response = await fetch(versions.cloudflared.source);
  if (!response.ok) throw new Error(`cloudflared download failed: ${response.status}`);
  const binary = join(stage, "tools/cloudflared.exe");
  writeFileSync(binary, Buffer.from(await response.arrayBuffer()));
  if (sha256(binary) !== versions.cloudflared.sha256) throw new Error("cloudflared official release hash mismatch.");
  writeFileSync(join(stage, "software.json"), JSON.stringify({ relay: { file: "tools/relay.exe", sha256: sha256(join(stage, "tools/relay.exe")) }, cloudflared: { file: "tools/cloudflared.exe", sha256: sha256(binary) } }, null, 2));
}
const release = { format: 1, platform: process.platform, arch: process.arch, nodeMajor: 24, software: includeRelay,
  remoteIntegrity: [["pairing/storage.js", sha256(join(modules, "remote-pi/dist/pairing/storage.js"))]] };
writeFileSync(join(stage, "release.json"), JSON.stringify(release, null, 2));
const files = inventory(stage);
const manifest = { ...release, files };
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
if (revision.status !== 0) throw new Error("Cannot identify source checkout revision.");
const pointer = { stage, manifestHash: sha256(join(stage, "manifest.json")), rootRevision: revision.stdout.trim() };
writeFileSync(join(root, ".build/windows-current.json"), JSON.stringify(pointer, null, 2));
console.log(JSON.stringify({ ...pointer, files: files.length, relayServer: includeRelay }));
