import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRecoveryGuard } from "../extensions/recovery-guard.ts";
import { installedPackageRoot } from "./installed-paths.mjs";

async function ensureHostVmShims(): Promise<Map<string, string> | undefined> {
  const entry = process.argv[1];
  if (entry && entry.endsWith("cli.js")) {
    const chunksDir = join(dirname(entry), "chunks");
    if (existsSync(chunksDir)) {
      const vmFile = readdirSync(chunksDir).find((f) => /^virtual-modules-.*\.js$/i.test(f));
      if (vmFile) {
        const vmChunkPath = join(chunksDir, vmFile);
        const cacheDir = join(tmpdir(), `pi-thagoras-vm-${vmFile.replace(/\.js$/i, "")}`);
        const manifestPath = join(cacheDir, "manifest.json");
        if (!existsSync(manifestPath)) {
          mkdirSync(cacheDir, { recursive: true });
          const { VIRTUAL_MODULES } = await import(pathToFileURL(vmChunkPath).href);
          const vmUrl = pathToFileURL(vmChunkPath).href;
          const manifest: Record<string, string> = {};
          for (const [spec, modObj] of Object.entries(VIRTUAL_MODULES as Record<string, Record<string, unknown>>)) {
            const fileName = spec.replace(/[^a-zA-Z0-9_-]/g, "_") + ".mjs";
            const keys = Object.keys(modObj).filter(
              (k) => k !== "default" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k),
            );
            const lines = [
              `import { VIRTUAL_MODULES } from ${JSON.stringify(vmUrl)};`,
              `const m = VIRTUAL_MODULES[${JSON.stringify(spec)}];`,
              ...keys.map((k) => `export const ${k} = m.${k};`),
              ...("default" in modObj ? ["export default m.default;"] : []),
              "",
            ];
            writeFileSync(join(cacheDir, fileName), lines.join("\n"), "utf8");
            manifest[spec] = fileName;
          }
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
        }
        const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
        const urlMap = new Map<string, string>();
        for (const [spec, fileName] of Object.entries(raw)) {
          urlMap.set(spec, pathToFileURL(join(cacheDir, fileName)).href);
        }
        return urlMap;
      }
    }
  }
  const shimsDir = join(dirname(fileURLToPath(import.meta.url)), "vm-shims");
  const manifestPath = join(shimsDir, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
  const urlMap = new Map<string, string>();
  for (const [spec, fileName] of Object.entries(raw)) {
    urlMap.set(spec, pathToFileURL(join(shimsDir, fileName)).href);
  }
  return urlMap;
}

async function installVirtualModulesHook() {
  const g = globalThis as Record<string, unknown>;
  if (g.__piThagorasVmHookInstalled || typeof registerHooks !== "function") return;
  try {
    const urlMap = await ensureHostVmShims();
    if (!urlMap) return;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (!Array.isArray(context?.conditions) || !context.conditions.includes("import")) {
          return nextResolve(specifier, context);
        }
        const hit = urlMap.get(specifier);
        if (hit) return { url: hit, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    g.__piThagorasVmHookInstalled = true;
  } catch {
    // Non-fatal fallback
  }
}

await installVirtualModulesHook();

export interface RecoveryHostPaths {
  guard: string;
  permissionSystem: string;
  reviewer: string;
  requiredChildApi: string;
}

/** The approved host adapter preserves the installed permission policy and reviewer. */
export function createRecoveryHost(paths: RecoveryHostPaths) {
  return function recoveryHost(pi: ExtensionAPI) {
    let startupFailure = "Recovery host has not completed session startup";
    let registration: { dispose(): void } | undefined;
    pi.on("tool_call", () => startupFailure ? { block: true, reason: startupFailure } : undefined);
    registerRecoveryGuard(pi);
    pi.on("session_start", async (_event, ctx) => {
      startupFailure = "Recovery host is registering required child protections";
      registration?.dispose();
      registration = undefined;
      try {
        const { registerRequiredChildExtensions } = await import(pathToFileURL(paths.requiredChildApi).href);
        registration = registerRequiredChildExtensions({
          sessionId: ctx.sessionManager.getSessionId(),
          extensions: [
            { id: "pi-thagoras-recovery", path: paths.guard },
            { id: "pi-permission-system", path: paths.permissionSystem },
            { id: "pi-auto-review", path: paths.reviewer },
          ],
          requireForAllRunners: true,
        });
        startupFailure = "";
      } catch (error) {
        startupFailure = `Required child protections unavailable; tools blocked: ${error instanceof Error ? error.message : String(error)}`;
        // Pi reports lifecycle errors; mandatory child startup treats this as fatal.
        throw new Error(startupFailure);
      }
    });
    pi.on("session_shutdown", () => {
      startupFailure = "Recovery host session is shut down";
      registration?.dispose();
      registration = undefined;
    });
  };
}

export default function recoveryHost(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const subagents = installedPackageRoot(agentDir, "pi-subagents");
  const resolve = createRequire(join(subagents, "package.json")).resolve;
  const paths: RecoveryHostPaths = {
    guard: join(agentDir, "extensions", "local-guards.ts"),
    permissionSystem: join(installedPackageRoot(agentDir, "@gotgenes/pi-permission-system"), "src", "index.ts"),
    reviewer: join(installedPackageRoot(agentDir, "@erichll/pi-auto-review"), "src", "index.ts"),
    requiredChildApi: resolve("pi-subagents/required-child-extensions"),
  };
  createRecoveryHost(paths)(pi);
}
