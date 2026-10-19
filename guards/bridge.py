"""One Pi shell event per process. Inspection can snapshot Git but never runs a shell command."""
import copy
import json
import sys

import common
import git_backup
import recycle_delete

SHELLS = {"bash": "posix", "powershell": "powershell"}


def inspect(payload):
    """Return a rewrite or a block; a rewrite grants no authorization."""
    try:
        tool = payload["tool_name"]
        shell = SHELLS.get(tool)
        if shell is None:
            raise ValueError("Unsupported tool; only Pi bash/powershell are covered")
        command = payload["tool_input"]["command"]
        if not isinstance(command, str) or not isinstance(payload["cwd"], str):
            raise ValueError("Expected literal command and working directory")
        common.select_shell(shell)
        adapted = copy.deepcopy(payload)
        adapted["tool_name"] = "Bash" if tool == "bash" else "PowerShell"
        notices = []
        for check in (recycle_delete.check, git_backup.check):
            result = check(adapted)
            if not result:
                continue
            output = result["hookSpecificOutput"]
            if output.get("permissionDecision") == "deny":
                return {"block": True, "reason": output["permissionDecisionReason"]}
            if "updatedInput" in output:
                adapted["tool_input"].update(output["updatedInput"])
            if output.get("additionalContext"):
                notices.append(output["additionalContext"])
        return {"block": False, "command": adapted["tool_input"]["command"], "notices": notices}
    except Exception as error:
        return {"block": True, "reason": f"Recovery inspection failed; command blocked: {error}"}


def main():
    try:
        result = inspect(json.load(sys.stdin))
    except Exception:
        result = {"block": True, "reason": "Recovery bridge received invalid JSON"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
