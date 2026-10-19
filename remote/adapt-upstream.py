"""Apply small, hash-pinned adaptations; never load remote-pi or access identity state."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STORAGE_SHA256 = "3eb49f9fabba75e3d8a9c64140c0b8d4b8f289bf29bc6c0def9227398a5093fd"

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def patch_storage(data: bytes) -> bytes:
    if sha256(data) != STORAGE_SHA256:
        raise ValueError("remote-pi 0.7.0 storage.js hash differs; inspect before adapting")
    text = data.decode("utf-8")
    entry = "export async function getOrCreateEd25519Keypair() {"
    fallback = '    const forceFile = process.env.REMOTE_PI_ALLOW_FILE_IDENTITY === "1";'
    reader = "await _readKeypairFromFile()"
    if text.count(entry) != 1 or text.count(fallback) != 1 or text.count(reader) != 2:
        raise ValueError("Unexpected identity implementation shape")
    text = ('import { assertNoFileIdentity, readAllowedFileIdentity, forbidWindowsFileFallback } '
            'from "./strict-windows-identity.js";\n') + text
    text = text.replace(entry, entry + "\n    await assertNoFileIdentity(IDENTITY_FILE);")
    text = text.replace(reader, "await readAllowedFileIdentity(_readKeypairFromFile)")
    text = text.replace(fallback, "    forbidWindowsFileFallback();\n" + fallback)
    return text.encode("utf-8")

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-root", type=Path, required=True,
                        help="Isolated node_modules/remote-pi path, not the live global extension")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    package_root = args.extension_root.resolve()
    package = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
    if package.get("name") != "remote-pi" or package.get("version") != "0.7.0":
        parser.error("Expected remote-pi 0.7.0")
    storage = package_root / "dist/pairing/storage.js"
    helper = package_root / "dist/pairing/strict-windows-identity.js"
    record = package_root.parent.parent / "strict-adaptation.json"
    original = storage.read_bytes()
    if record.exists():
        existing = json.loads(record.read_text(encoding="utf-8"))
        if sha256(original) != existing.get("storageSha256") or not helper.exists() or sha256(helper.read_bytes()) != existing.get("helperSha256"):
            parser.error("Existing strict adaptation changed; inspect before proceeding")
        print(json.dumps({"status": "already-adapted", "identityAccessed": False}))
        return 0
    patched = patch_storage(original)
    helper_data = (ROOT / "strict-windows-identity.mjs").read_bytes()
    result = {"version": "0.7.0", "upstreamStorageSha256": STORAGE_SHA256,
              "storageSha256": sha256(patched), "helperSha256": sha256(helper_data),
              "windowsBackend": "CredentialManager-only", "identityAccessed": False}
    if args.apply:
        helper.write_bytes(helper_data)
        storage.write_bytes(patched)
        record.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "applied" if args.apply else "plan-only", **result}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
