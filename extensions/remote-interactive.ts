import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRuntimeConfig } from "../remote/runtime-config.mjs";

// Only ordinary interactive Pi processes get phone access. Native children keep
// their explicit extension allowlist; this also excludes print/JSON/RPC hosts.
export function isInteractivePi(argv: string[], inputTty: boolean, outputTty: boolean) {
  if (!inputTty || !outputTty || argv.includes("-p") || argv.includes("--print")) return false;
  const mode = argv.indexOf("--mode");
  return mode < 0 || argv[mode + 1] === "text";
}

export default async function (pi: ExtensionAPI) {
  if (!isInteractivePi(process.argv.slice(2), !!process.stdin.isTTY, !!process.stdout.isTTY)) return;
  const config = loadRuntimeConfig();
  if (config.remoteHome) process.env.REMOTE_PI_HOME = config.remoteHome;
  const root = config.remotePackageRoot ? join(config.remotePackageRoot, "dist")
    : join(config.runtimeRoot, "extension-0.7.0", "node_modules", "remote-pi", "dist");
  const expected = [
    ["pairing/storage.js", "6ab9e6a767ae6097e67a84d7987d29e1d417a4cde1409c3be84af046eb1c0015"],
    ["pairing/strict-windows-identity.js", "5c381bb084e7932fbdbb5abaca26873b1eb1b3111a2015b0713d059d9108ed38"],
  ];
  for (const [file, digest] of config.remoteIntegrity ?? expected) {
    if (createHash("sha256").update(readFileSync(join(root, file))).digest("hex") !== digest)
      throw new Error("remote-pi strict Windows identity patch changed; phone access was not loaded.");
  }
  // Process-local defaults: no user-wide environment changes and no credential reads here.
  if (!config.relayUrl) throw new Error("Configure a relay URL with pi-thagoras setup before using interactive phone access.");
  process.env.REMOTE_PI_RELAY = config.relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  if (!process.env.REMOTE_PI_DIRECT_CONFIG) {
    const { loadLocalConfig } = await import(pathToFileURL(join(root, "session/local_config.js")).href);
    process.env.REMOTE_PI_DIRECT_CONFIG = JSON.stringify({ ...loadLocalConfig(process.cwd()), auto_start_relay: true });
  }
  const remote = await import(pathToFileURL(join(root, "index.js")).href);
  await remote.default(pi);
}
