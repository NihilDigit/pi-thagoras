"""Pi extension contract checks using the already-installed Jiti, never a model call."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from test_recovery_guard import RecoveryFixture
from runtime_paths import package_root


class ExtensionContractTests(RecoveryFixture):
    def run_extension(self, mode):
        node = shutil.which("node")
        package = package_root("@earendil-works/pi-coding-agent", "PI_THAGORAS_PI_PACKAGE")
        jiti = package.parent.parent / "jiti"
        if not node or not jiti.is_dir():
            self.skipTest("Build the Windows runtime or set PI_THAGORAS_PI_PACKAGE first")
        extension = Path(__file__).resolve().parents[1] / "extensions/recovery-guard.ts"
        fixture = self.work / "keep.txt"
        fixture.write_text("keep")
        script = r"""
const {createJiti} = require(process.argv[1]);
const jiti = createJiti(process.cwd() + '/recovery-contract.cjs', { fsCache: false, moduleCache: false });
const extension = jiti(process.argv[2]);
const mode = process.argv[3];
const handlers = [];
const pi = {on: (name, fn) => {if(name === 'tool_call') handlers.push(fn)}};
delete process.env.PI_THAGORAS_RECOVERY;
delete process.env.PI_THAGORAS_RECOVERY_REVIEW_ORDER;
if(mode === 'missing-order') process.env.PI_THAGORAS_RECOVERY = '1';
if(mode === 'composed') extension.registerRecoveryGuard(pi); else extension.default(pi);
const event = {toolName:'powershell', input:{command:"Remove-Item -LiteralPath 'keep.txt'"}};
const ctx = {cwd:process.argv[4], sessionManager:{getSessionId:()=> 'fixture'}};
(async()=>{
 let decision;
 for(const handler of handlers) { decision = await handler(event, ctx); if(decision?.block) break; }
 // Controlled mock of a later reviewer, not a live permission-plugin claim.
 const reviewedCommand = event.input.command;
 console.log(JSON.stringify({handlers:handlers.length, decision, reviewedCommand}));
})().catch(e=>{console.error(e.message); process.exitCode=1});
"""
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run([node, "-e", script, str(jiti), str(extension), mode, str(self.work)], capture_output=True, text=True, encoding="utf-8", env=env, check=True, timeout=30)
        self.assertTrue(fixture.exists(), "hook must not execute deletion while deciding")
        return json.loads(result.stdout)

    def test_live_host_sdk_lifecycle_registers_required_children_and_releases(self):
        node = shutil.which("node")
        package = package_root("@earendil-works/pi-coding-agent", "PI_THAGORAS_PI_PACKAGE")
        live = Path.home() / ".pi/agent/extensions/local-guards.ts"
        native = Path.home() / ".pi/agent/npm/node_modules/pi-subagents/src/shared/required-child-extensions.js"
        if not node or not package.is_dir() or not live.is_file() or not native.is_file():
            self.skipTest("Approved live host or installed SDK unavailable; no installation performed")
        script = r"""
const {pathToFileURL}=require('node:url');
(async()=>{
 const sdk=process.argv[1]+'/dist/core/';
 const {loadExtensions}=await import(pathToFileURL(sdk+'extensions/loader.js').href);
 const {ExtensionRunner}=await import(pathToFileURL(sdk+'extensions/runner.js').href);
 const {createEventBus}=await import(pathToFileURL(sdk+'event-bus.js').href);
 const native=await import(pathToFileURL(process.argv[3]).href);
 const loaded=await loadExtensions([process.argv[2]],process.argv[4],createEventBus());
 if(loaded.errors.length)throw new Error(JSON.stringify(loaded.errors));
 const id='pi-thagoras-sdk-fixture-'+process.pid+'-'+Date.now();
 const ctx={cwd:process.argv[4],sessionManager:{getSessionId:()=>id}};
 const runner={extensions:loaded.extensions,createContext:()=>ctx};
 const event={type:'tool_call',toolName:'read',toolCallId:'fixture',input:{path:'not-executed'}};
 const before=await ExtensionRunner.prototype.emitToolCall.call(runner,event);
 let snapshot,after,remoteRejected=false;
 try{
  for(const ext of loaded.extensions)for(const handler of ext.handlers.get('session_start')??[])await handler({type:'session_start',reason:'startup'},ctx);
  snapshot=native.resolveRequiredChildExtensions(id);
  after=await ExtensionRunner.prototype.emitToolCall.call(runner,event);
  try{native.assertRequiredChildExtensionsAdmitted([snapshot],{agent:'fixture',machine:'fixture-only'})}catch{remoteRejected=true}
 }finally{
  for(const ext of loaded.extensions)for(const handler of ext.handlers.get('session_shutdown')??[])await handler({type:'session_shutdown',reason:'quit'},ctx);
 }
 console.log(JSON.stringify({before,after,snapshot,remoteRejected,remaining:native.resolveRequiredChildExtensions(id).length}));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
"""
        output = subprocess.run([node,"-e",script,str(package),str(live),str(native),str(self.work)],check=True,capture_output=True,text=True,encoding="utf-8",timeout=30)
        result = json.loads(output.stdout)
        self.assertTrue(result["before"]["block"])
        self.assertFalse(result.get("after",{}).get("block",False))
        self.assertEqual([entry["id"] for entry in result["snapshot"]],["pi-thagoras-recovery","pi-permission-system","pi-auto-review"])
        self.assertTrue(all(entry["requireForAllRunners"] for entry in result["snapshot"]))
        self.assertTrue(result["remoteRejected"])
        self.assertEqual(result["remaining"],0)
        self.assertFalse(self.state.exists())

    def test_extension_is_inert_by_default(self):
        result = self.run_extension("disabled")
        self.assertEqual(result["handlers"], 0)
        self.assertFalse(self.state.exists())

    def test_extension_blocks_if_order_opt_in_is_missing(self):
        result = self.run_extension("missing-order")
        self.assertTrue(result["decision"]["block"])
        self.assertIn("guard-before-review", result["decision"]["reason"])
        self.assertFalse(self.state.exists())

    def test_controlled_later_reviewer_observes_rewrite(self):
        result = self.run_extension("composed")
        self.assertEqual(result["handlers"], 1)
        self.assertFalse(result.get("decision", {}).get("block", False))
        self.assertIn("recycle --encoded", result["reviewedCommand"])
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
