import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoFileIdentity, readAllowedFileIdentity, forbidWindowsFileFallback } from "./strict-windows-identity.mjs";

test("Windows existing identity blocks without reading its contents", async () => {
  let called = false;
  await assert.rejects(assertNoFileIdentity("fixture-only", {
    platform: "win32", stat: async () => { called = true; return {}; }
  }), /existing file identity/);
  assert.equal(called, true);
});
test("Windows missing identity is the only accepted stat failure", async () => {
  await assertNoFileIdentity("fixture-only", { platform: "win32",
    stat: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
  await assert.rejects(assertNoFileIdentity("fixture-only", { platform: "win32",
    stat: async () => { throw Object.assign(new Error(), { code: "EACCES" }); } }), /blocked/);
});
test("Windows never invokes any identity-file reader", async () => {
  assert.equal(await readAllowedFileIdentity(() => { throw new Error("must not read"); }, "win32"), null);
});
test("Windows fallback always fails, including native-module load failure path", () => {
  assert.throws(() => forbidWindowsFileFallback("win32"), /fallback is disabled/);
});
test("Other platforms retain upstream file backend behavior", async () => {
  await assertNoFileIdentity("fixture-only", { platform: "linux", stat: () => { throw new Error("unused"); } });
  assert.equal(await readAllowedFileIdentity(() => "fake fixture", "linux"), "fake fixture");
  assert.doesNotThrow(() => forbidWindowsFileFallback("linux"));
});
