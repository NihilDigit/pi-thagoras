import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path, fallback = {}) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const names = ["pi-thagoras", "pi-subagents", "@gotgenes/pi-permission-system", "@erichll/pi-auto-review", "@lll9p/pi-better-compaction", "pi-web-search"];
function packageName(item) {
  const source = typeof item === "string" ? item : item?.source;
  if (typeof source !== "string") return;
  if (source.startsWith("npm:")) return source.slice(4).match(/^(?:@[^/]+\/)?[^@]+/)?.[0];
  return read(join(source, "package.json")).name;
}
function defaults(existing, base) {
  const result = { ...base, ...existing };
  for (const [key, value] of Object.entries(base)) {
    if (value && typeof value === "object" && !Array.isArray(value)) result[key] = defaults(existing?.[key] ?? {}, value);
  }
  return result;
}
const within = (parent, path) => { const rel = relative(parent, path); return !rel.startsWith("..") && !isAbsolute(rel); };

export function planProfile({ releaseRoot, sourceRoot = releaseRoot, checkoutRoot, agentDir, runtimeRoot, projectPath, relayUrl, port = 4317, machineName = "pitato" }) {
  releaseRoot = resolve(releaseRoot); agentDir = resolve(agentDir); runtimeRoot = resolve(runtimeRoot); projectPath = resolve(projectPath);
  if (!statSync(projectPath).isDirectory()) throw new Error("Select an existing project directory.");
  if ([agentDir, runtimeRoot].some((path) => within(projectPath, path) || within(releaseRoot, path) || (checkoutRoot && within(resolve(checkoutRoot), path)))) throw new Error("Agent and runtime data must stay outside the project, source checkout and installed code.");
  const relay = new URL(relayUrl);
  if (relay.username || relay.password || relay.search || relay.hash ||
    (relay.protocol !== "wss:" && !(relay.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(relay.hostname)))) throw new Error("Use a wss relay URL without credentials; ws is allowed only for loopback tests.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Host port must be between 1024 and 65535.");
  const previous = read(join(agentDir, "pi-thagoras.json"));
  const guard = join(agentDir, "extensions", "local-guards.ts");
  if (existsSync(guard) && !previous.releaseRoot) throw new Error("An existing local-guards.ts is not owned by this installer. Review and migrate it before applying setup.");
  const app = join(releaseRoot, "app"), modules = join(releaseRoot, "node_modules");
  const seed = join(sourceRoot, "app");
  const entry = (name, path = "src/index.ts") => join(modules, name, path);
  const permission = entry("@gotgenes/pi-permission-system"), reviewer = entry("@erichll/pi-auto-review");
  const compaction = entry("@lll9p/pi-better-compaction", "index.ts");
  const settingsPath = join(agentDir, "settings.json"), existing = read(settingsPath);
  const settings = defaults(existing, read(join(seed, "settings.json")));
  settings.packages = [...(existing.packages ?? []).filter((item) => {
    const source = typeof item === "string" ? item : item?.source;
    return !names.includes(packageName(item)) && !(previous.releaseRoot && typeof source === "string" && isAbsolute(source) && within(previous.releaseRoot, source));
  }),
    join(modules, "pi-web-search"), join(modules, "@gotgenes/pi-permission-system"), join(modules, "@lll9p/pi-better-compaction"),
    join(modules, "@erichll/pi-auto-review"), join(modules, "pi-subagents"), app];
  settings.subagents = { ...settings.subagents, defaultSubagentOnlyExtensions: [guard, permission, reviewer, compaction,
    ...(existing.subagents?.defaultSubagentOnlyExtensions ?? []).filter((path) => path !== guard && !(previous.releaseRoot && within(previous.releaseRoot, path)))] };
  const modelPath = join(agentDir, "models.json"), modelDefaults = read(join(seed, "models.json"));
  const models = defaults(read(modelPath), modelDefaults);
  for (const [name, provider] of Object.entries(modelDefaults.providers ?? {})) {
    const defined = new Set((models.providers[name].models ?? []).map((model) => model.id));
    models.providers[name].models = [...(models.providers[name].models ?? []), ...(provider.models ?? []).filter((model) => !defined.has(model.id))];
  }
  const permissionPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
  const policy = read(permissionPath, read(join(seed, "config", "permissions.json")));
  if (!(policy.authorizerChain ?? []).includes("pi-auto-review")) throw new Error("Existing permission policy does not include pi-auto-review; review its authorizer chain before setup.");
  const infoPath = join(agentDir, "pi-thagoras.json");
  policy.permission ??= {}; policy.permission.path ??= {};
  if (typeof policy.permission.path === "string") policy.permission.path = { "*": policy.permission.path };
  policy.permission.path[join(agentDir, "auth.json").replaceAll("\\", "/")] = "deny";
  const reviewPath = join(agentDir, "extensions", "pi-auto-review", "config.json");
  const review = defaults(read(reviewPath), { model: "openai/codex-auto-review" });
  const piCli = entry("@earendil-works/pi-coding-agent", "dist/bundle/cli.js"), remotePackageRoot = join(modules, "remote-pi");
  const release = read(join(sourceRoot, "release.json"));
  const remoteHome = join(runtimeRoot, "home");
  const recoveryState = join(runtimeRoot, "recovery");
  const info = { format: 1, releaseRoot, agentDir, runtimeRoot, remoteHome, recoveryState, piCli, piVersion: "1.3.0", relayUrl,
    remotePackageRoot, remoteIntegrity: release.remoteIntegrity, softwareManifest: release.software ? join(releaseRoot, "software.json") : undefined };
  const hostPath = join(runtimeRoot, "pitato", "host.json");
  const host = { ...read(hostPath), name: machineName, projects: [{ id: "primary", name: projectPath.split(/[/\\]/).at(-1), cwd: projectPath }],
    relayUrl, trustProjects: false, port, piBin: piCli, agentDir, releaseRoot, remoteHome, recoveryState, remotePackageRoot };
  const wrapper = `// Managed by pi-thagoras. Generated for this machine.\nexport default async function(pi) {\nprocess.env.PI_THAGORAS_RECOVERY_STATE ??= ${JSON.stringify(recoveryState)};\nconst { createRecoveryHost } = await import(${JSON.stringify(pathToFileURL(join(app, "guards/live-entry.ts")).href)});\ncreateRecoveryHost(${json({ guard, permissionSystem: permission, reviewer, requiredChildApi: entry("pi-subagents", "src/api/required-child-extensions.js") }).trim()})(pi);\n}\n`;
  const appendPath = join(agentDir, "APPEND_SYSTEM.md"), begin = "<!-- pi-thagoras:start -->", end = "<!-- pi-thagoras:end -->";
  const current = existsSync(appendPath) ? readFileSync(appendPath, "utf8") : "";
  const block = `${begin}\n${readFileSync(join(seed, "APPEND_SYSTEM.md"), "utf8").trim()}\n${end}`;
  const start = current.indexOf(begin), finish = current.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error("Incomplete pi-thagoras prompt markers; repair them before applying setup.");
  const append = start >= 0 ? current.slice(0, start) + block + current.slice(finish + end.length) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const launcher = `$env:PI_CODING_AGENT_DIR=${quote(agentDir)}\n$env:PI_MANAGED_INSTALL_ROOT=${quote(releaseRoot)}\n$env:PI_THAGORAS_RECOVERY_STATE=${quote(recoveryState)}\n& node ${quote(piCli)} @args\nexit $LASTEXITCODE\n`;
  return { info, files: new Map([[settingsPath, json(settings)], [modelPath, json(models)], [permissionPath, json(policy)], [reviewPath, json(review)], [infoPath, json(info)],
    [guard, wrapper], [appendPath, append], [hostPath, json(host)], [join(agentDir, "bin", "pi-thagoras.ps1"), launcher],
    [join(agentDir, "bin", "pi-thagoras.cmd"), '@echo off\r\npwsh -NoProfile -File "%~dp0pi-thagoras.ps1" %*\r\n']]) };
}

export function applyProfile(plan) {
  const id = randomUUID();
  const backup = join(plan.info.agentDir, ".pi-thagoras-backups", new Date().toISOString().replace(/[:.]/g, "-") + "-" + id);
  const originals = [];
  for (const [path] of plan.files) {
    if (existsSync(path)) {
      const target = join(backup, String(originals.length));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(path, target);
      originals.push({ path, backup: target });
    }
  }
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const receipt = { phase: "prepared", originals, created: [...plan.files.keys()].filter((path) => !existsSync(path)), retired: [] };
  const save = () => writeFileSync(join(backup, "manifest.json"), json(receipt), { mode: 0o600 });
  save();
  const pending = new Map(), applied = [];
  try {
    for (const [path, content] of plan.files) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + ".pending-" + id;
      writeFileSync(temporary, content, { mode: 0o600 }); pending.set(path, temporary);
    }
    for (const [path, temporary] of pending) { renameSync(temporary, path); applied.push(path); }
    receipt.phase = "applied"; save();
  } catch (error) {
    for (const path of applied.reverse()) {
      const original = originals.find((item) => item.path === path);
      if (original) copyFileSync(original.backup, path);
      else { const retired = path + ".failed-" + id; renameSync(path, retired); receipt.retired.push(retired); }
    }
    for (const temporary of pending.values()) if (existsSync(temporary)) {
      const retired = temporary.replace(".pending-", ".failed-"); renameSync(temporary, retired); receipt.retired.push(retired);
    }
    receipt.phase = "rolled-back"; save(); throw error;
  }
  return { files: plan.files.size, backup };
}
