import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadRuntimeConfig({ agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), localFile = join(dirname(fileURLToPath(import.meta.url)), "runtime-path.local.json") } = {}) {
  agentDir = resolve(agentDir.replace(/^~(?=[/\\])/, homedir()));
  const installed = join(agentDir, "pi-thagoras.json");
  const config = existsSync(installed) ? JSON.parse(readFileSync(installed, "utf8"))
    : existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : {};
  const runtimeRoot = config.runtimeRoot ?? join(agentDir, "pi-thagoras-state");
  return { ...config, runtimeRoot, logicalRuntimeRoot: config.logicalRuntimeRoot ?? runtimeRoot };
}
