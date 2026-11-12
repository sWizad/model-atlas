#!/usr/bin/env python3
"""Copy every file cited in specs/sources.json into sources/<key><ext>.

The atlas reads source lines live off the machine that built it. On any other
machine (a laptop, Windows) those absolute paths do not exist, so serve.py falls
back to these snapshots. Re-run this on the build host after `build_viz.py`
whenever an upstream file changes, so the snapshot matches the line refs in
webui/data/.

Usage:  python webui/snapshot_sources.py
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES_JSON = os.path.join(ROOT, "specs", "sources.json")
SNAP_DIR = os.path.join(ROOT, "sources")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("snapshot_sources")


def snapshot_name(key: str, path: str) -> str:
    """sources/<key><ext> — the name serve.py looks up when the live file is absent."""
    return key + os.path.splitext(path)[1]


def main() -> int:
    try:
        with open(SOURCES_JSON, encoding="utf-8") as f:
            sources = json.load(f)
    except (OSError, ValueError) as exc:
        log.error("cannot read %s: %s", SOURCES_JSON, exc)
        return 1
    os.makedirs(SNAP_DIR, exist_ok=True)
    missing = 0
    for key, entry in sources.items():
        if key.startswith("_"):
            continue
        src = entry["path"]
        dst = os.path.join(SNAP_DIR, snapshot_name(key, src))
        try:
            shutil.copyfile(src, dst)
            log.info("%-16s <- %s", key, src)
        except OSError as exc:
            missing += 1
            log.warning("%-16s NOT copied (%s)", key, exc)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
