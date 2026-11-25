#!/usr/bin/env python3
"""FocusMe: one local place for the things you need to remember.

Run it with `python3 focusme.py`. It starts a small server on 127.0.0.1 and
opens your browser. Everything lives in a single SQLite file, by default
~/.focusme/focusme.db. Standard library only, Python 3.8+.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import urllib.request
import webbrowser
from contextlib import contextmanager
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEFAULT_PORT = 4777
BACKUPS_TO_KEEP = 14
MAX_BODY = 20 * 1024 * 1024  # 20 MB, plenty for an import file

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    title    TEXT    NOT NULL DEFAULT '',
    body     TEXT    NOT NULL DEFAULT '',
    tags     TEXT    NOT NULL DEFAULT '[]',
    pinned   INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    date     TEXT,
    created  TEXT    NOT NULL,
    updated  TEXT    NOT NULL
);
"""

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def clean_tags(value):
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        raise ValueError("tags must be a list")
    seen = []
    for raw in value:
        tag = str(raw).strip().lstrip("#").strip().lower()
        tag = re.sub(r"\s+", " ", tag)
        if tag and tag not in seen:
            seen.append(tag[:60])
    return seen


def clean_date(value):
    if value in (None, ""):
        return None
    value = str(value)
    if not DATE_RE.match(value):
        raise ValueError("date must be YYYY-MM-DD")
    date.fromisoformat(value)  # raises on nonsense like 2026-02-31
    return value


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        c = sqlite3.connect(str(self.path), timeout=10)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    @staticmethod
    def to_dict(row):
        d = dict(row)
        d["tags"] = json.loads(d["tags"] or "[]")
        d["pinned"] = bool(d["pinned"])
        d["archived"] = bool(d["archived"])
        return d

    def all(self):
        with self.conn() as c:
            rows = c.execute("SELECT * FROM items ORDER BY updated DESC").fetchall()
        return [self.to_dict(r) for r in rows]

    def get(self, c, item_id):
        row = c.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return self.to_dict(row) if row else None

    @staticmethod
    def clean_fields(data):
        out = {}
        if "title" in data:
            out["title"] = str(data["title"] or "")[:500]
        if "body" in data:
            out["body"] = str(data["body"] or "")
        if "tags" in data:
            out["tags"] = json.dumps(clean_tags(data["tags"]))
        if "pinned" in data:
            out["pinned"] = 1 if data["pinned"] else 0
        if "archived" in data:
            out["archived"] = 1 if data["archived"] else 0
        if "date" in data:
            out["date"] = clean_date(data["date"])
        return out

    def create(self, data, created=None, updated=None):
        fields = self.clean_fields(data)
        ts = now_iso()
        fields["created"] = created or ts
        fields["updated"] = updated or ts
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        with self.lock, self.conn() as c:
            cur = c.execute(
                "INSERT INTO items ({}) VALUES ({})".format(cols, marks),
                list(fields.values()),
            )
            return self.get(c, cur.lastrowid)

    def update(self, item_id, data):
        fields = self.clean_fields(data)
        with self.lock, self.conn() as c:
            if not self.get(c, item_id):
                return None
            if fields:
                fields["updated"] = now_iso()
                sets = ", ".join("{} = ?".format(k) for k in fields)
                c.execute(
                    "UPDATE items SET {} WHERE id = ?".format(sets),
                    list(fields.values()) + [item_id],
                )
            return self.get(c, item_id)

    def delete(self, item_id):
        with self.lock, self.conn() as c:
            return c.execute("DELETE FROM items WHERE id = ?", (item_id,)).rowcount > 0

    def import_items(self, items):
        """Add items from an export. Skips anything that already exists."""
        with self.conn() as c:
            existing = {
                (r["created"], r["title"])
                for r in c.execute("SELECT created, title FROM items")
            }
        added = 0
        for raw in items:
            if not isinstance(raw, dict):
                continue
            key = (raw.get("created"), str(raw.get("title") or ""))
            if key in existing:
                continue
            try:
                self.create(raw, created=raw.get("created"), updated=raw.get("updated"))
            except ValueError:
                continue
            existing.add(key)
            added += 1
        return added

    def daily_backup(self):
        """Keep one snapshot per day next to the database, newest 14 kept."""
        backups = self.path.parent / "backups"
        backups.mkdir(exist_ok=True)
        target = backups / "focusme-{}.db".format(date.today().isoformat())
        if not target.exists():
            src = sqlite3.connect(str(self.path))
            dst = sqlite3.connect(str(target))
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
        snaps = sorted(backups.glob("focusme-*.db"))
        for old in snaps[:-BACKUPS_TO_KEEP]:
            old.unlink()


class Handler(BaseHTTPRequestHandler):
    server_version = "FocusMe"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    # ---- helpers ---------------------------------------------------------

    @property
    def store(self):
        return self.server.store

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.send_json(status, {"error": message})

    def host_ok(self):
        # Only answer requests addressed to this machine. Blocks DNS rebinding.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("127.0.0.1", "localhost")

    def origin_ok(self):
        # Writes must come from our own page, never from some other website.
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        parsed = urlparse(origin)
        return parsed.hostname in ("127.0.0.1", "localhost") and parsed.port == self.server.server_port

    def read_json(self):
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
        if ctype != "application/json":
            raise ValueError("expected application/json")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("request too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data

    def item_id(self, path):
        m = re.match(r"^/api/items/(\d+)$", path)
        return int(m.group(1)) if m else None

    def guard(self, write=False):
        if not self.host_ok():
            self.error(403, "forbidden host")
            return False
        if write and not self.origin_ok():
            self.error(403, "forbidden origin")
            return False
        return True

    # ---- routes ----------------------------------------------------------

    def do_GET(self):
        if not self.guard():
            return
        path = urlparse(self.path).path
        if path == "/api/ping":
            return self.send_json(200, {"app": "focusme"})
        if path == "/api/info":
            return self.send_json(200, {"data": str(self.store.path)})
        if path == "/api/items":
            return self.send_json(200, self.store.all())
        if path == "/api/export":
            name = "focusme-{}.json".format(date.today().isoformat())
            return self.send_json(
                200,
                {"app": "focusme", "exported": now_iso(), "items": self.store.all()},
                {"Content-Disposition": 'attachment; filename="{}"'.format(name)},
            )
        return self.static(path)

    def do_POST(self):
        if not self.guard(write=True):
            return
        path = urlparse(self.path).path
        try:
            data = self.read_json()
            if path == "/api/items":
                return self.send_json(201, self.store.create(data))
            if path == "/api/import":
                items = data.get("items")
                if not isinstance(items, list):
                    raise ValueError("no items found in that file")
                return self.send_json(200, {"added": self.store.import_items(items)})
        except (ValueError, json.JSONDecodeError) as exc:
            return self.error(400, str(exc))
        self.error(404, "not found")

    def do_PATCH(self):
        if not self.guard(write=True):
            return
        item_id = self.item_id(urlparse(self.path).path)
        if item_id is None:
            return self.error(404, "not found")
        try:
            item = self.store.update(item_id, self.read_json())
        except (ValueError, json.JSONDecodeError) as exc:
            return self.error(400, str(exc))
        if item is None:
            return self.error(404, "not found")
        self.send_json(200, item)

    def do_DELETE(self):
        if not self.guard(write=True):
            return
        item_id = self.item_id(urlparse(self.path).path)
        if item_id is None or not self.store.delete(item_id):
            return self.error(404, "not found")
        self.send_response(204)
        self.end_headers()

    def static(self, path):
        if path == "/":
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in target.parents or not target.is_file():
            return self.error(404, "not found")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def already_running(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:{}/api/ping".format(port), timeout=1) as r:
            return json.load(r).get("app") == "focusme"
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(description="FocusMe: a local place for things you need to remember.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("FOCUSME_PORT", DEFAULT_PORT)))
    parser.add_argument(
        "--data",
        default=os.environ.get("FOCUSME_DATA", str(Path.home() / ".focusme")),
        help="folder that holds focusme.db (default ~/.focusme, or $FOCUSME_DATA)",
    )
    parser.add_argument("--no-open", action="store_true", help="don't open the browser")
    args = parser.parse_args()

    url = "http://127.0.0.1:{}/".format(args.port)

    if already_running(args.port):
        print("FocusMe is already running, opening {}".format(url))
        if not args.no_open:
            webbrowser.open(url)
        return

    store = Store(Path(args.data).expanduser() / "focusme.db")
    try:
        store.daily_backup()
    except Exception as exc:  # a failed backup should never stop the app
        print("warning: backup skipped ({})".format(exc), file=sys.stderr)

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        sys.exit("Couldn't start on port {}: {}. Try --port.".format(args.port, exc))
    server.store = store

    print("FocusMe is running at {}".format(url))
    print("Data: {}".format(store.path))
    print("Press Ctrl+C to stop.")
    if not args.no_open:
        threading.Timer(0.4, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
