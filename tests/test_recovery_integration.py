"""Fixture integration with installed permission-system handler/boundary and reviewer broker.

The model reviewer and policy selection are deterministic in-memory stubs. No live
extension entrypoint, user policy, audit database, key, OAuth, or model is loaded.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from test_recovery_guard import RecoveryFixture
from runtime_paths import package_root
import storage


class InstalledPermissionIntegrationTests(RecoveryFixture):
    def inspect_chain(self, command, mode="allow", tool="powershell"):
        node = shutil.which("node")
        pi_package = package_root("@earendil-works/pi-coding-agent", "PI_THAGORAS_PI_PACKAGE")
        permission = package_root("@gotgenes/pi-permission-system", "PI_THAGORAS_PERMISSION_PACKAGE")
        reviewer = package_root("@erichll/pi-auto-review", "PI_THAGORAS_REVIEWER_PACKAGE")
        jiti = pi_package.parent.parent / "jiti"
        if not node or not jiti.is_dir() or not permission.is_dir() or not reviewer.is_dir():
            self.skipTest("Existing installed permission/reviewer modules unavailable; no installation performed")
        self.assertEqual(json.loads((permission / "package.json").read_text())["version"], "40.0.2")
        self.assertEqual(json.loads((reviewer / "package.json").read_text())["version"], "0.26.0")
        extension = Path(__file__).resolve().parents[1] / "extensions/recovery-guard.ts"
        script = r"""
const {createJiti} = require(process.argv[1]);
const jiti = createJiti(process.cwd() + '/recovery-integration.cjs', {fsCache:false,moduleCache:false});
const guard = jiti(process.argv[2]);
const permission = process.argv[3];
const reviewer = process.argv[4];
const {createFailClosedToolCall} = jiti(permission + '/src/handlers/tool-call-boundary.ts');
const {PermissionGateHandler} = jiti(permission + '/src/handlers/permission-gate-handler.ts');
const {BoundaryApprovalBroker} = jiti(reviewer + '/src/broker/broker.ts');
const cwd = process.argv[5], command = process.argv[6], mode = process.argv[7], tool = process.argv[8];
const handlers = [], reviewed = [], audit = [];
const pi = {on: (name,handler)=>{if(name==='tool_call') handlers.push(handler)}};
guard.registerRecoveryGuard(pi);
const broker = new BoundaryApprovalBroker({
 reviewer:async(request)=>{
   reviewed.push(request.command);
   if(mode === 'unavailable') throw new Error('fixture model unavailable');
   return {outcome:mode==='deny'?'deny':'allow',riskLevel:'low',userAuthorization:'high',rationale:'fixture deterministic reviewer; no model request'};
 }, audit:event=>audit.push(event), failureMode:'deny', breakGlassEnabled:false,
});
const session = {activate:()=>{}, resolveAgentName:()=> 'fixture'};
const tools = {getAll:()=>[{name:'powershell'},{name:'bash'}]};
// Only the resolver/pipeline policy selection is stubbed: installed handler
// extraction/validation, fail-closed boundary and broker execution are real.
const pipeline = {evaluate:async(tcc)=>{
 const decision = await broker.review({id:'fixture',source:'permission-system',surface:'command',operation:'execute',cwd:tcc.cwd,command:tcc.input.command,toolName:tcc.toolName}, {sessionId:'fixture',scopeKey:'fixture-turn',issueGrant:false});
 return decision.kind==='allow'?{action:'allow'}:{action:'block',reason:decision.review.rationale};
}};
const gates = new PermissionGateHandler(session,tools,pipeline,{},{});
const reporter={writeReviewLog:()=>{},emitDecision:()=>{}};
const recorder={recordDecision:()=>{},recordError:()=>{}};
handlers.push(createFailClosedToolCall((event,ctx)=>gates.handleToolCall(event,ctx),reporter,recorder,{debug:()=>{}}));
const event={toolName:tool,toolCallId:'fixture-call',input:{command}};
const ctx={cwd,sessionManager:{getSessionId:()=> 'fixture'}};
(async()=>{
 let result={};
 // Same sequential short-circuit semantics verified in Pi 1.1 emitToolCall.
 for(const handler of handlers){const next=await handler(event,ctx);if(next){result=next;if(result.block)break}}
 console.log(JSON.stringify({result,command:event.input.command,reviewed,auditEvents:audit.map(e=>e.type)}));
})().catch(error=>{console.error(error.stack);process.exitCode=1});
"""
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run([node,"-e",script,str(jiti),str(extension),str(permission),str(reviewer),str(self.work),command,mode,tool], check=True,capture_output=True,text=True,encoding="utf-8",env=env,timeout=30)
        return json.loads(result.stdout)

    def execute_fixture_command(self, command, tool="powershell"):
        if tool == "bash":
            shell = Path("C:/Program Files/Git/bin/bash.exe")
            if not shell.is_file():
                self.skipTest("Existing Git Bash unavailable; no installation performed")
            subprocess.run([str(shell),"--noprofile","--norc","-c",command],cwd=self.work,check=True,capture_output=True)
            return
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell unavailable for fixture execution")
        subprocess.run([shell,"-NoLogo","-NoProfile","-NonInteractive","-Command",command],cwd=self.work,check=True,capture_output=True)

    def test_installed_boundary_and_broker_review_final_recycle_then_restore(self):
        target = self.work / "keep.txt"
        target.write_text("original")
        outcome = self.inspect_chain("Remove-Item -LiteralPath 'keep.txt'")
        self.assertFalse(outcome["result"].get("block",False),outcome)
        self.assertEqual(outcome["reviewed"],[outcome["command"]])
        self.assertIn("recycle --encoded",outcome["reviewed"][0])
        self.assertTrue(target.exists())
        self.execute_fixture_command(outcome["command"])
        self.assertFalse(target.exists())
        entry = self.entries("trash")[0]
        target.write_text("new")
        with self.assertRaises(FileExistsError):
            storage.restore_trash(entry)
        self.assertEqual(target.read_text(),"new")
        target.unlink()  # Only this test's fixture, created directly above.
        storage.restore_trash(entry)
        self.assertEqual(target.read_text(),"original")

    def test_installed_chain_git_bash_recycles_and_restores_fixture(self):
        target = self.work / "keep.txt"
        target.write_text("bash fixture")
        outcome = self.inspect_chain("rm -- 'keep.txt'", tool="bash")
        self.assertFalse(outcome["result"].get("block",False),outcome)
        self.assertEqual(outcome["reviewed"],[outcome["command"]])
        self.assertIn("recycle --encoded",outcome["command"])
        self.assertTrue(target.exists(),"inspection must not execute deletion")
        self.execute_fixture_command(outcome["command"],tool="bash")
        self.assertFalse(target.exists())
        entry = self.entries("trash")[0]
        storage.restore_trash(entry)
        self.assertEqual(target.read_text(),"bash fixture")

    def test_installed_reviewer_broker_deny_preserves_target(self):
        target = self.work / "keep.txt"
        target.write_text("keep")
        outcome = self.inspect_chain("Remove-Item -LiteralPath 'keep.txt'","deny")
        self.assertTrue(outcome["result"]["block"])
        self.assertEqual(outcome["reviewed"],[outcome["command"]])
        self.assertEqual(target.read_text(),"keep")
        self.assertFalse(self.state.exists())

    def test_installed_broker_unavailable_fails_closed_without_deletion(self):
        target = self.work / "keep.txt"
        target.write_text("keep")
        outcome = self.inspect_chain("Remove-Item -LiteralPath 'keep.txt'","unavailable")
        self.assertTrue(outcome["result"]["block"])
        self.assertEqual(target.read_text(),"keep")
        self.assertFalse(self.state.exists())

    def test_installed_chain_snapshots_before_destructive_fixture_git(self):
        self.make_repo()
        before = self.git("diff","--binary")
        outcome = self.inspect_chain("git reset --hard")
        self.assertFalse(outcome["result"].get("block",False),outcome)
        entry = self.entries("git")[0]
        record = json.loads((entry/"manifest.json").read_text())
        self.assertTrue(record["complete"])
        self.assertEqual((entry/"worktree.patch").read_bytes(),before)
        self.assertEqual(outcome["reviewed"],["git reset --hard"])
        self.execute_fixture_command(outcome["command"])
        self.assertEqual((self.work/"tracked.txt").read_text(),"original\n")
        self.assertIn(b"worktree",(entry/"worktree.patch").read_bytes())

    def test_snapshot_failure_blocks_before_installed_reviewer(self):
        self.make_repo()
        blocked_state = self.base / "CodexSetup"
        before = self.git("diff","--binary")
        with unittest.mock.patch.dict(os.environ,{"PI_THAGORAS_RECOVERY_STATE":str(blocked_state)}):
            outcome = self.inspect_chain("git reset --hard")
        self.assertTrue(outcome["result"]["block"])
        self.assertEqual(outcome["reviewed"],[])
        self.assertIn("Legacy Codex storage",outcome["result"]["reason"])
        self.assertEqual(self.git("diff","--binary"),before)
        self.assertFalse(blocked_state.exists())


if __name__ == "__main__":
    unittest.main()
