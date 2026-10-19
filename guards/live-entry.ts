import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRecoveryGuard } from "../extensions/recovery-guard.ts";
import { installedPackageRoot } from "./installed-paths.mjs";

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
