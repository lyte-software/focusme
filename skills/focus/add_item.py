#!/usr/bin/env python3
"""Add one item to the FocusMe database, using FocusMe's own Store so the
same cleanup rules apply (tags lowercased and deduped, dates validated)."""

import argparse
import json
import os
import sys
from pathlib import Path

# Resolves through the ~/.claude/skills symlink to this repo: skills/focus/ -> repo root.
FOCUSME_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(FOCUSME_DIR))
from focusme import Store  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--title", required=True)
p.add_argument("--body", default="")
p.add_argument("--tags", default="", help="comma separated")
p.add_argument("--date", default="", help="YYYY-MM-DD")
p.add_argument("--pin", action="store_true")
a = p.parse_args()

data_dir = Path(os.environ.get("FOCUSME_DATA", str(Path.home() / ".focusme"))).expanduser()
store = Store(data_dir / "focusme.db")
try:
    item = store.create({
        "title": a.title,
        "body": a.body,
        "tags": a.tags,
        "date": a.date or None,
        "pinned": a.pin,
    })
except ValueError as exc:
    sys.exit("error: {}".format(exc))
print(json.dumps(item, indent=2))
