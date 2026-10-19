"""Fixture-only recovery tests. No commands operate on the user's projects or state."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "guards"))
import bridge
import common
import git_backup
import storage


class RecoveryFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-thagoras-recovery-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.work = self.base / "work"
        self.work.mkdir()
        self.env = patch.dict(os.environ, {"PI_THAGORAS_RECOVERY_STATE": str(self.state), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        self.env.start()
        self.addCleanup(self.env.stop)

    def request(self, command, tool="powershell"):
        return {"tool_name": tool, "tool_input": {"command": command}, "cwd": str(self.work), "session_id": "fixture"}

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.work), *args], check=True, capture_output=True).stdout

    def make_repo(self):
        self.git("init", "-q")
        (self.work / "tracked.txt").write_text("original\n", encoding="utf-8")
        (self.work / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        (self.work / "tracked.txt").write_text("staged\n", encoding="utf-8")
        self.git("add", "tracked.txt")
        (self.work / "tracked.txt").write_text("worktree\n", encoding="utf-8")
        (self.work / "untracked.txt").write_text("untracked", encoding="utf-8")
        (self.work / "ignored.txt").write_text("ignored", encoding="utf-8")

    def entries(self, category):
        return list((self.state / category).iterdir())


class RecoveryTests(RecoveryFixture):
    def test_shell_selected_from_tool_not_windows_host(self):
        common.select_shell("posix")
        posix = common.parse_commands("rm -f -- 'a b'")[0]
        common.select_shell("powershell")
        pwsh = common.parse_commands("rm -LiteralPath 'a b'")[0]
        self.assertEqual((posix.name, posix.shell, posix.args[-1]), ("rm", "posix", "a b"))
        self.assertEqual((pwsh.name, pwsh.shell, pwsh.args[-1]), ("remove-item", "powershell", "a b"))

    def test_rewrite_does_not_delete_before_review_and_roundtrips(self):
        target = self.work / "a ' b.txt"
        target.write_text("keep me", encoding="utf-8")
        request = self.request("Remove-Item -LiteralPath 'a '' b.txt'")
        decision = bridge.inspect(request)
        self.assertFalse(decision["block"], decision)
        self.assertTrue(target.exists(), "inspection must not perform deletion")
        self.assertEqual(request["tool_input"]["command"], "Remove-Item -LiteralPath 'a '' b.txt'")
        self.assertNotEqual(decision["command"], request["tool_input"]["command"])
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell unavailable for command rewrite execution test")
        subprocess.run([shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", decision["command"]], check=True, capture_output=True)
        self.assertFalse(target.exists())
        entry = self.entries("trash")[0]
        self.assertEqual((entry / "content").read_text(encoding="utf-8"), "keep me")
        self.assertEqual(storage.restore_trash(entry), target)
        self.assertEqual(target.read_text(encoding="utf-8"), "keep me")

    def test_git_snapshot_preserves_staged_worktree_untracked_and_ignored(self):
        self.make_repo()
        before = self.git("diff", "--binary")
        decision = bridge.inspect(self.request("git clean -fdx"))
        self.assertFalse(decision["block"], decision)
        self.assertEqual(decision["command"], "git clean -fdx")
        entry = self.entries("git")[0]
        record = json.loads((entry / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(record["complete"])
        self.assertEqual(record["owner"], "pi-thagoras")
        self.assertEqual((entry / "worktree.patch").read_bytes(), before)
        self.assertIn(b"staged", (entry / "staged.patch").read_bytes())
        self.assertTrue((entry / "index").is_file())
        with tarfile.open(entry / "untracked.tar") as archive:
            self.assertEqual(set(archive.getnames()), {"untracked.txt", "ignored.txt"})
        self.assertTrue(record["refs"])
        self.assertTrue(all(ref["name"].startswith("refs/pi-thagoras/") for ref in record["refs"]))
        self.assertEqual(self.git("diff", "--binary"), before)
        self.assertEqual((self.work / "untracked.txt").read_text(), "untracked")

    def test_backup_failure_blocks_git_without_running_requested_command(self):
        target = self.work / "untouched.txt"
        target.write_text("untouched")
        with patch.object(git_backup, "backup", side_effect=OSError("fixture disk full")):
            decision = bridge.inspect(self.request("git reset --hard"))
        self.assertTrue(decision["block"])
        self.assertIn("fixture disk full", decision["reason"])
        self.assertEqual(target.read_text(), "untouched")

    def test_changed_worktree_during_snapshot_blocks_operation(self):
        self.make_repo()
        original = git_backup.git
        calls = 0
        def changing(repo, *args, **kwargs):
            nonlocal calls
            if args[:2] == ("diff", "--binary"):
                calls += 1
                if calls == 2:
                    (self.work / "tracked.txt").write_text("concurrent change\n")
            return original(repo, *args, **kwargs)
        with patch.object(git_backup, "git", side_effect=changing):
            decision = bridge.inspect(self.request("git reset --hard"))
        self.assertTrue(decision["block"])
        self.assertIn("changed during backup", decision["reason"])
        self.assertFalse(json.loads((self.entries("git")[0] / "manifest.json").read_text())["complete"])

    def test_dry_run_git_creates_no_snapshot(self):
        decision = bridge.inspect(self.request("git clean -ndx"))
        self.assertFalse(decision["block"])
        self.assertFalse(self.state.exists())

    def test_indirect_or_compound_deletion_blocks_without_side_effect(self):
        target = self.work / "keep.txt"
        target.write_text("keep")
        for command in ["Remove-Item keep.txt; Write-Output done", "python -c 'import os; os.remove(\"keep.txt\")'", "cmd /c del keep.txt"]:
            with self.subTest(command=command):
                self.assertTrue(bridge.inspect(self.request(command))["block"])
                self.assertTrue(target.exists())

    def test_invalid_bridge_payload_blocks(self):
        for payload in [{}, self.request("echo ok", "shell"), self.request(None)]:
            self.assertTrue(bridge.inspect(payload)["block"])

    def test_restore_refuses_to_overwrite(self):
        target = self.work / "file.txt"
        target.write_text("old")
        entry = Path(storage.recycle([target])[0])
        target.write_text("new")
        with self.assertRaises(FileExistsError):
            storage.restore_trash(entry)
        self.assertEqual(target.read_text(), "new")
        self.assertEqual((entry / "content").read_text(), "old")

    def test_expiry_is_explicit_and_owner_scoped_at_7_and_30_days(self):
        target = self.work / "file.txt"
        target.write_text("trash")
        with patch.object(storage.time, "time", return_value=1000):
            trash = Path(storage.recycle([target])[0])
        with storage.locked() as state:
            with patch.object(storage.time, "time", return_value=1000):
                git_entry, record = storage.new_entry(state, "git", refs=[])
            record["complete"] = True
            storage.write_record(git_entry, record)
            foreign, foreign_record = storage.new_entry(state, "trash")
            foreign_record.update(owner="codex-setup", created=0)
            storage.write_record(foreign, foreign_record)
        removed, errors = storage.cleanup(root=self.state, now=1000 + 7 * 86400 - 1)
        self.assertEqual((removed, errors), ([], []))
        removed, errors = storage.cleanup(root=self.state, now=1000 + 7 * 86400)
        self.assertEqual(removed, [f"trash/{trash.name}"])
        self.assertFalse(errors)
        self.assertTrue(git_entry.exists())
        self.assertTrue(foreign.exists())
        removed, errors = storage.cleanup(root=self.state, now=1000 + 30 * 86400)
        self.assertEqual(removed, [f"git/{git_entry.name}"])
        self.assertFalse(errors)
        self.assertTrue(foreign.exists())

    def test_inspection_never_implicitly_cleans_old_entries(self):
        target = self.work / "old.txt"
        target.write_text("old")
        with patch.object(storage.time, "time", return_value=0):
            entry = Path(storage.recycle([target])[0])
        self.make_repo()
        decision = bridge.inspect(self.request("git reset --hard"))
        self.assertFalse(decision["block"], decision)
        self.assertTrue(entry.exists())

    def test_changed_ref_prevents_expired_backup_cleanup(self):
        self.make_repo()
        bridge.inspect(self.request("git reset --hard"))
        entry = self.entries("git")[0]
        record = json.loads((entry / "manifest.json").read_text())
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "second")
        self.git("update-ref", record["refs"][0]["name"], "HEAD")
        removed, errors = storage.cleanup(root=self.state, now=record["created"] + 30 * 86400)
        self.assertEqual(removed, [])
        self.assertTrue(any("Backup ref changed" in error for error in errors))
        self.assertTrue(entry.exists())
        self.assertEqual(self.git("rev-parse", record["refs"][0]["name"]), self.git("rev-parse", "HEAD"))

    def test_legacy_namespaces_and_unowned_directory_are_rejected(self):
        for name in ["CodexSetup", "CodexGuard", "codex-setup", ".codex"]:
            legacy = self.base / name
            with self.assertRaises(ValueError):
                storage.checked_root(legacy)
            self.assertFalse(legacy.exists())
        unowned = self.base / "unowned"
        unowned.mkdir()
        (unowned / "keep").write_text("keep")
        with self.assertRaises(ValueError):
            storage.cleanup(root=unowned, now=10**10)
        self.assertEqual((unowned / "keep").read_text(), "keep")

    def test_codex_state_environment_is_ignored(self):
        legacy = self.base / "CodexSetup"
        with patch.dict(os.environ, {"CODEX_SETUP_STATE": str(legacy)}):
            self.assertEqual(storage.state_root(), self.state)
        self.assertFalse(legacy.exists())

    def test_link_target_is_never_followed_during_recycle_or_cleanup(self):
        outside = self.work / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        link = self.work / "link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("fixture symlink creation unavailable")
        entry = Path(storage.recycle([link])[0])
        self.assertTrue((outside / "keep.txt").exists())
        record = json.loads((entry / "manifest.json").read_text())
        storage.cleanup(root=self.state, now=record["created"] + 7 * 86400)
        self.assertEqual((outside / "keep.txt").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
