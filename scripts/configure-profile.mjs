import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planProfile, applyProfile } from "./lib/profile.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (key === "--apply") options.apply = true;
  else if (["--release", "--source", "--agent", "--runtime", "--project", "--relay", "--port"].includes(key)) options[key.slice(2)] = process.argv[++index];
  else throw new Error(`Unknown option: ${key}`);
}
for (const name of ["release", "agent", "runtime", "project", "relay"]) if (!options[name]) throw new Error(`Missing --${name}`);
const plan = planProfile({ releaseRoot: options.release, sourceRoot: options.source ?? options.release, agentDir: options.agent,
  checkoutRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  runtimeRoot: options.runtime, projectPath: options.project, relayUrl: options.relay, port: Number(options.port ?? 4317), machineName: hostname() });
console.log(JSON.stringify({ apply: options.apply === true, files: [...plan.files.keys()], ...(options.apply ? applyProfile(plan) : {}) }, null, 2));
