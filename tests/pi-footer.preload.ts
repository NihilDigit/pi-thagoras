// Resolve Pi's real TUI library without installing packages or changing package.json.
// PI_FOOTER_PI_ROOT is the installed coding-agent package directory, not an auth directory.
import { mock } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = process.env.PI_FOOTER_PI_ROOT;
if (!root) throw new Error("Set PI_FOOTER_PI_ROOT to the installed @earendil-works/pi-coding-agent directory");
const fromPi = createRequire(resolve(root, "package.json"));
const realTui = await import(fromPi.resolve("@earendil-works/pi-tui"));
// Alias only: all implementations (especially visibleWidth) are the installed Pi exports.
mock.module("@earendil-works/pi-tui", () => realTui);
