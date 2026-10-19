"""Locate installed or freshly built packages without machine-specific paths."""
import json
import os
from pathlib import Path


def package_root(name, override):
    if os.environ.get(override):
        return Path(os.environ[override]).expanduser()
    agent = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi/agent")
    repo = Path(__file__).resolve().parents[1]
    candidates = []
    for file, key in [(repo / ".build/windows-current.json", "stage"), (agent / "pi-thagoras.json", "releaseRoot")]:
        if file.is_file():
            candidates.append(Path(json.loads(file.read_text(encoding="utf-8-sig"))[key]) / "node_modules" / name)
    settings = agent / "settings.json"
    if settings.is_file():
        for item in json.loads(settings.read_text(encoding="utf-8-sig")).get("packages", []):
            source = item if isinstance(item, str) else item.get("source", "")
            if source.startswith(f"npm:{name}@") or source == f"npm:{name}":
                candidates.append(agent / "npm/node_modules" / name)
            elif Path(source).is_absolute():
                candidates.append(Path(source))
    for candidate in candidates:
        file = candidate / "package.json"
        if file.is_file() and json.loads(file.read_text(encoding="utf-8-sig")).get("name") == name:
            return candidate
    return repo / ".build/not-installed" / name
