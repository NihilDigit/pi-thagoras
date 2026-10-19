import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function inventory(root) {
  const files = [];
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Release must not depend on a link: ${path}`);
      if (item.isDirectory()) walk(path);
      else files.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(path) });
    }
  }
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
