import { createWriteStream, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--config") throw new Error("Usage: node run-host.mjs --config <host.json>");
const configPath = resolve(args[1]);
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.agentDir) process.env.PI_CODING_AGENT_DIR = config.agentDir;
if (config.releaseRoot) process.env.PI_MANAGED_INSTALL_ROOT = config.releaseRoot;
if (config.remoteHome) process.env.REMOTE_PI_HOME = config.remoteHome;
if (config.recoveryState) process.env.PI_THAGORAS_RECOVERY_STATE = config.recoveryState;
const state = dirname(configPath);
const originalError = process.stderr.write.bind(process.stderr);
const output = createWriteStream(join(state, "host.log"), { flags: "a", mode: 0o600 });
const errors = createWriteStream(join(state, "host-error.log"), { flags: "a", mode: 0o600 });
for (const stream of [output, errors]) {
  stream.on("error", (error) => { originalError(`Host log unavailable: ${error.message}\n`); process.exit(1); });
}
process.stdout.write = output.write.bind(output);
process.stderr.write = errors.write.bind(errors);

// Preserve the managed launcher's protection context without an extra process.
const managedRoot = join(homedir(), ".pi", "agent", "install");
const cliRelative = relative(managedRoot, resolve(config.piBin));
if (cliRelative && !cliRelative.startsWith("..") && !isAbsolute(cliRelative)) {
  process.env.PI_MANAGED_INSTALL_ROOT = managedRoot;
}
const entry = config.remotePackageRoot ? join(config.remotePackageRoot, "dist/bin/pitato-host.js")
  : join(dirname(fileURLToPath(import.meta.url)), "../upstream/remote_pi/pi-extension/dist/bin/pitato-host.js");
await import(pathToFileURL(entry).href);
