import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const bridge = fileURLToPath(new URL("../guards/bridge.py", import.meta.url));

type Decision = { block: boolean; reason?: string; command?: string; notices?: string[] };

/** Call before permission reviewer registration; it must review the final rewritten input. */
export function registerRecoveryGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const original = event.input.command;
    try {
      const decision = await new Promise<Decision>((resolve, reject) => {
        const child = spawn("python", ["-B", "-X", "utf8", bridge], {
          windowsHide: true, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.length > 1_048_576) { child.kill(); reject(new Error("recovery response too large")); }
        });
        child.stderr.resume();
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`recovery process exited ${code}`));
          try {
            const value = JSON.parse(output);
            if (typeof value.block !== "boolean") throw new Error("missing recovery decision");
            resolve(value);
          } catch { reject(new Error("invalid recovery response")); }
        });
        child.stdin.on("error", reject);
        child.stdin.end(JSON.stringify({
          tool_name: event.toolName, tool_input: event.input, cwd: ctx.cwd,
          session_id: ctx.sessionManager.getSessionId(),
        }));
      });
      if (decision.block) return { block: true, reason: decision.reason ?? "recovery denied operation" };
      if (typeof decision.command !== "string") throw new Error("recovery returned no command");
      // Detect concurrent mutation while inspection was awaiting the child process.
      if (event.input.command !== original) throw new Error("command changed during recovery inspection");
      event.input.command = decision.command;
    } catch (error) {
      return { block: true, reason: `Recovery unavailable; command blocked: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
}

/** Inert unless explicitly enabled. Registration order alone is not a security boundary. */
export default function recoveryGuard(pi: ExtensionAPI) {
  if (process.env.PI_THAGORAS_RECOVERY !== "1") return;
  if (process.env.PI_THAGORAS_RECOVERY_REVIEW_ORDER !== "guard-before-review") {
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash" || event.toolName === "powershell") {
        return { block: true, reason: "Recovery activation requires verified guard-before-review ordering" };
      }
    });
    return;
  }
  registerRecoveryGuard(pi);
}
