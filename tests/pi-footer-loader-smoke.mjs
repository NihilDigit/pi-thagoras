// Load only this extension through Pi's actual Node/Jiti loader. No session, auth or network.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PI_FOOTER_PI_ROOT;
assert.ok(root, "Set PI_FOOTER_PI_ROOT to the installed coding-agent directory");
assert.ok(["0", "false"].includes(process.env.JITI_FS_CACHE), "Disable Jiti disk cache for this read-only smoke test");
const { loadExtensions } = await import(pathToFileURL(resolve(root, "dist/core/extensions/loader.js")).href);
const result = await loadExtensions([resolve("extensions/pi-footer.ts")], process.cwd());
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, 1);
const extension = result.extensions[0];
for (const event of ["session_start", "session_shutdown", "before_provider_request", "message_update", "message_end", "provider_stream_event"]) {
	assert.equal(extension.handlers.get(event)?.length, 1, event);
}
assert.equal(extension.tools.size, 0);
assert.deepEqual([...extension.commands.keys()], ["pi-footer"]);
console.log(`Pi loader smoke passed: ${extension.handlers.size} event handlers, no session/auth/network started`);
