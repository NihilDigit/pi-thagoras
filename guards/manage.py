"""Explicit recovery management. Never scans another Agent's recovery namespace."""
import argparse
import json
from pathlib import Path

from storage import cleanup, restore_trash


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True, help="Dedicated Pi Thagoras recovery directory")
    sub = parser.add_subparsers(dest="action", required=True)
    restore = sub.add_parser("restore-trash")
    restore.add_argument("entry", type=Path)
    clean = sub.add_parser("cleanup")
    clean.add_argument("--confirm-expired-pi-thagoras-only", action="store_true", required=True)
    args = parser.parse_args()
    if args.action == "restore-trash":
        print(restore_trash(args.entry, root=args.state))
    else:
        removed, errors = cleanup(root=args.state)
        print(json.dumps({"removed": removed, "errors": errors}, ensure_ascii=False))
        if errors:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
