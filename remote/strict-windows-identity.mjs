import { stat as fileStat } from "node:fs/promises";

export async function assertNoFileIdentity(path, options = {}) {
  const platform = options.platform ?? process.platform;
  const stat = options.stat ?? fileStat;
  if (platform !== "win32") return;
  try {
    await stat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw new Error("Cannot establish Windows identity-file absence; identity creation is blocked.");
  }
  throw new Error("Windows Credential Manager is required. An existing file identity needs manual handling; no key was read or migrated.");
}

export async function readAllowedFileIdentity(readFileIdentity, platform = process.platform) {
  return platform === "win32" ? null : readFileIdentity();
}

export function forbidWindowsFileFallback(platform = process.platform) {
  if (platform === "win32") {
    throw new Error("Windows Credential Manager is unavailable. File identity fallback is disabled.");
  }
}
