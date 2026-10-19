import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function installedPackageRoot(agentDir, name) {
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const roots = [];
  for (const item of settings.packages ?? []) {
    const source = typeof item === "string" ? item : item.source;
    if (typeof source !== "string") continue;
    if (source.startsWith(`npm:${name}@`) || source === `npm:${name}`) {
      roots.push(join(agentDir, "npm", "node_modules", name));
    } else if (!/^(npm:|git:|https?:)/.test(source)) {
      const root = resolve(source.replace(/^~(?=[/\\])/, homedir()));
      const manifest = join(root, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) roots.push(root);
    }
  }
  const unique = [...new Set(roots)];
  if (unique.length !== 1) throw new Error(`Expected one installed ${name} package; run pi-thagoras setup or doctor.`);
  return unique[0];
}
