"""Codex hook payloads and the repository's shell parsers."""

import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "lib"))
import pwshcmds
import shellcmds


_active_shell = None


def select_shell(shell):
    global _active_shell
    if shell not in {"posix", "powershell"}:
        raise ValueError("An explicit supported shell is required")
    _active_shell = shell


def parse_commands(raw):
    if _active_shell is None:
        raise ValueError("Shell has not been selected by the adapter")
    return (pwshcmds if _active_shell == "powershell" else shellcmds).executed_commands(raw)


def run_hook(check):
    try:
        payload = json.load(sys.stdin)
        result = check(payload)
        if result:
            json.dump(result, sys.stdout, ensure_ascii=False)
    except Exception as exc:
        json.dump(deny(f"Hook 未完成检查，已拦截本次操作：{exc}"), sys.stdout, ensure_ascii=False)


def deny(reason):
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}


def context(message):
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": message}}
