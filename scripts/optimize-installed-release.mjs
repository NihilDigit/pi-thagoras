import { resolve } from "node:path";
import { optimizeRelease } from "./lib/optimize-release.mjs";

const releaseRoot = process.argv[2];
if (!releaseRoot) {
  throw new Error("Usage: node scripts/optimize-installed-release.mjs <releaseRoot>");
}
await optimizeRelease(resolve(releaseRoot));
