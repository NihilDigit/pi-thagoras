import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path, fallback = {}) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const names = ["pi-thagoras", "pi-subagents", "@gotgenes/pi-permission-system", "@erichll/pi-auto-review", "@router-for-me/pi-cliproxyapi-provider", "pi-web-search"];
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

export function planProfile({ releaseRoot, sourceRoot = releaseRoot, checkoutRoot, agentDir, runtimeRoot }) {
  releaseRoot = resolve(releaseRoot); agentDir = resolve(agentDir); runtimeRoot = resolve(runtimeRoot);
  if ([agentDir, runtimeRoot].some((path) => within(releaseRoot, path) || (checkoutRoot && within(resolve(checkoutRoot), path)))) throw new Error("Agent and runtime data must stay outside the source checkout and installed code.");
  const previous = read(join(agentDir, "pi-thagoras.json"));
  const guard = join(agentDir, "extensions", "local-guards.ts");
  if (existsSync(guard) && !previous.releaseRoot) throw new Error("An existing local-guards.ts is not owned by this installer. Review and migrate it before applying setup.");
  const app = join(releaseRoot, "app"), modules = join(releaseRoot, "node_modules");
  const seed = join(sourceRoot, "app");
  const entry = (name, path = "src/index.ts") => join(modules, name, path);
  const permission = entry("@gotgenes/pi-permission-system"), reviewer = entry("@erichll/pi-auto-review");
  const settingsPath = join(agentDir, "settings.json"), existing = read(settingsPath);
  const settings = defaults(existing, read(join(seed, "settings.json")));
  settings.packages = [...(existing.packages ?? []).filter((item) => {
    const source = typeof item === "string" ? item : item?.source;
    return !names.includes(packageName(item)) && !(previous.releaseRoot && typeof source === "string" && isAbsolute(source) && within(previous.releaseRoot, source));
  }),
    join(modules, "pi-web-search"), join(modules, "@gotgenes/pi-permission-system"),
    join(modules, "@erichll/pi-auto-review"), join(modules, "pi-subagents"),
    { source: join(modules, "@router-for-me/pi-cliproxyapi-provider"), extensions: ["!extensions/tps.ts"] },
    app];
  settings.subagents = { ...settings.subagents, defaultSubagentOnlyExtensions: [guard, permission, reviewer,
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
  const subagentConfigPath = join(agentDir, "extensions", "subagent", "config.json");
  const subagentConfig = defaults(read(subagentConfigPath), read(join(seed, "config", "subagent.json"), {
    asyncByDefault: true,
    forceTopLevelAsync: true,
    asyncWidget: false,
    fleetView: false,
    inlineToolDisplay: "summary",
  }));
  const piCli = entry("@earendil-works/pi-coding-agent", "dist/bundle/cli.js");
  const release = read(join(sourceRoot, "release.json"));
  const recoveryState = join(runtimeRoot, "recovery");
  const info = { format: 1, releaseRoot, agentDir, runtimeRoot, recoveryState, piCli, piVersion: "1.3.0",
    softwareManifest: release.software ? join(releaseRoot, "software.json") : undefined };
  const wrapper = `// Managed by pi-thagoras. Generated for this machine.\nexport default async function(pi) {\nprocess.env.PI_THAGORAS_RECOVERY_STATE ??= ${JSON.stringify(recoveryState)};\nconst { createRecoveryHost } = await import(${JSON.stringify(pathToFileURL(join(app, "guards/live-entry.ts")).href)});\ncreateRecoveryHost(${json({ guard, permissionSystem: permission, reviewer, requiredChildApi: entry("pi-subagents", "src/api/required-child-extensions.js") }).trim()})(pi);\n}\n`;
  const appendPath = join(agentDir, "APPEND_SYSTEM.md"), begin = "<!-- pi-thagoras:start -->", end = "<!-- pi-thagoras:end -->";
  const current = existsSync(appendPath) ? readFileSync(appendPath, "utf8") : "";
  const block = `${begin}\n${readFileSync(join(seed, "APPEND_SYSTEM.md"), "utf8").trim()}\n${end}`;
  const start = current.indexOf(begin), finish = current.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error("Incomplete pi-thagoras prompt markers; repair them before applying setup.");
  const append = start >= 0 ? current.slice(0, start) + block + current.slice(finish + end.length) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const launcher = `chcp.com 65001 >$null\n[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$env:PI_CODING_AGENT_DIR=${quote(agentDir)}\n$env:PI_THAGORAS_RECOVERY_STATE=${quote(recoveryState)}\n$installRoot = Join-Path $env:PI_CODING_AGENT_DIR 'install'\n$verFile = Join-Path $installRoot 'current-version'\nif (Test-Path -LiteralPath $verFile) {\n  $ver = (Get-Content -LiteralPath $verFile -Raw).Trim()\n  $managedCli = Join-Path $installRoot "releases\\$ver\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"\n  if (Test-Path -LiteralPath $managedCli) {\n    $env:PI_MANAGED_INSTALL_ROOT = $installRoot\n    & node $managedCli @args\n    exit $LASTEXITCODE\n  }\n}\n$env:PI_MANAGED_INSTALL_ROOT=${quote(releaseRoot)}\n& node ${quote(piCli)} @args\nexit $LASTEXITCODE\n`;
  const cmdLauncher = `@echo off\r\nchcp 65001 >nul\r\nset "PI_CODING_AGENT_DIR=${agentDir}"\r\nset "PI_THAGORAS_RECOVERY_STATE=${recoveryState}"\r\nif exist "%PI_CODING_AGENT_DIR%\\install\\current-version" (\r\n  set /p PI_CUR_VER=<"%PI_CODING_AGENT_DIR%\\install\\current-version"\r\n  set "PI_MANAGED_INSTALL_ROOT=%PI_CODING_AGENT_DIR%\\install"\r\n  call node "%PI_CODING_AGENT_DIR%\\install\\releases\\%%PI_CUR_VER%%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\nset "PI_MANAGED_INSTALL_ROOT=${releaseRoot}"\r\nnode "${piCli}" %*\r\n`;
  return { info, files: new Map([[settingsPath, json(settings)], [modelPath, json(models)], [permissionPath, json(policy)], [reviewPath, json(review)], [subagentConfigPath, json(subagentConfig)], [infoPath, json(info)],
    [guard, wrapper], [appendPath, append], [join(agentDir, "bin", "pi-thagoras.ps1"), launcher],
    [join(agentDir, "bin", "pi-thagoras.cmd"), cmdLauncher],
    [join(agentDir, "bin", "pi.ps1"), launcher],
    [join(agentDir, "bin", "pi.cmd"), cmdLauncher]]) };
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
