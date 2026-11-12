#!/usr/bin/env python3
"""model_atlas server: static page + a read-only source-code endpoint.

Static serving follows documents/webui/webui_tool_playbook.md §3:
HTTP/1.1 keep-alive, `no-cache` (never `no-store`) on app assets + data,
whole-body gzip for JSON >= 32 KB with an mtime-keyed cache and 304s.

Source endpoint:
  GET /api/src?src=<key>&a=<line>&b=<line>
      `src` is an ALLOWLIST KEY, never a path. Keys come from the generated
      webui/data/allowlist.json (built by build_viz.py from the specs), so a
      client can only read files a diagram actually references.
      -> 200 {src, path, label, lang, start, end, lines[], sha8, nlines}
      -> 400 bad/oversized range · 403 unknown key · 404 {"absent":true}

Source resolution (ATLAS_SOURCES): `auto` (default) reads the live file named in
sources.json and falls back to the snapshot sources/<key><ext> when it is absent
(any machine other than the build host, e.g. Windows); `snapshot` always reads
the snapshot; `live` never falls back.

Usage:  python serve.py [PORT]   (default 8877)
Env:    ATLAS_HOST (default 0.0.0.0) · ATLAS_SOURCES · ATLAS_OPEN=1 opens a browser
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
ALLOWLIST = os.path.join(ROOT, "data", "allowlist.json")
SNAP_DIR = os.path.join(os.path.dirname(ROOT), "sources")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8877
HOST = os.environ.get("ATLAS_HOST", "0.0.0.0")
SOURCES_MODE = os.environ.get("ATLAS_SOURCES", "auto").lower()
GZIP_MIN = 32 * 1024
MAX_SPAN = 400  # lines per /api/src request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("model_atlas")

_gzip_cache: dict[str, tuple[float, int, bytes]] = {}
_gzip_lock = threading.Lock()
_allow_cache: dict[str, Any] = {"mtime": 0.0, "data": {}}
_allow_lock = threading.Lock()


def allowlist() -> dict[str, dict]:
    """The generated key -> {path, lang, label} map, reloaded when it changes."""
    try:
        st = os.stat(ALLOWLIST)
    except OSError:
        return {}
    with _allow_lock:
        if _allow_cache["mtime"] != st.st_mtime:
            try:
                with open(ALLOWLIST, encoding="utf-8") as f:
                    _allow_cache["data"] = json.load(f)
                _allow_cache["mtime"] = st.st_mtime
            except (OSError, ValueError) as exc:
                log.error("allowlist unreadable: %s", exc)
                return {}
        return _allow_cache["data"]


def candidate_paths(key: str, live: str) -> list[str]:
    """Files to try for one allowlist key, in order, per ATLAS_SOURCES."""
    snap = os.path.join(SNAP_DIR, key + os.path.splitext(live)[1])
    if SOURCES_MODE == "snapshot":
        return [snap]
    if SOURCES_MODE == "live":
        return [live]
    return [live, snap]


class H(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Explicit types: on Windows, mimetypes reads the registry, which can map
    # .js to text/plain and break the page.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".svg": "image/svg+xml",
    }

    def __init__(self, *a: Any, **k: Any) -> None:
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---------- helpers ----------

    def _json(self, obj: Any, code: int = 200, cache: Optional[str] = None,
              etag: Optional[str] = None) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if cache:
            self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        if len(body) >= GZIP_MIN and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        super().end_headers()
        self.wfile.write(body)

    def _gzip_file(self, fp: str) -> Optional[bytes]:
        if not fp.endswith(".json") or "gzip" not in (self.headers.get("Accept-Encoding") or ""):
            return None
        try:
            st = os.stat(fp)
        except OSError:
            return None
        if st.st_size < GZIP_MIN:
            return None
        with _gzip_lock:
            hit = _gzip_cache.get(fp)
            if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
                return hit[2]
        try:
            with open(fp, "rb") as f:
                gz = gzip.compress(f.read(), 6)
        except OSError as exc:
            log.warning("gzip read failed %s: %s", fp, exc)
            return None
        with _gzip_lock:
            _gzip_cache[fp] = (st.st_mtime, st.st_size, gz)
        return gz

    # ---------- /api/src ----------

    def _api_src(self, qs: dict[str, list[str]]) -> None:
        key = (qs.get("src") or [""])[0]
        entry = allowlist().get(key)
        if not entry:
            return self._json({"error": f"unknown src key {key!r}"}, 403)
        try:
            a = int((qs.get("a") or ["1"])[0])
            b = int((qs.get("b") or [str(a)])[0])
        except ValueError:
            return self._json({"error": "a/b must be integers"}, 400)
        if a < 1 or b < a:
            return self._json({"error": f"bad range {a}-{b}"}, 400)
        if b - a + 1 > MAX_SPAN:
            return self._json({"error": f"range too large ({b - a + 1} > {MAX_SPAN} lines)"}, 400)

        live = entry["path"]
        all_lines: Optional[list[str]] = None
        path = live
        for path in candidate_paths(key, live):
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    all_lines = f.read().splitlines()
                break
            except FileNotFoundError:
                continue
            except OSError as exc:
                log.error("read failed %s: %s", path, exc)
                return self._json({"error": f"cannot read source: {exc}"}, 500)
        if all_lines is None:
            return self._json({"absent": True, "path": live,
                               "error": "file not present on this host (no snapshot either)"}, 404)
        snapshot = path != live

        end = min(b, len(all_lines))
        if a > len(all_lines):
            return self._json({"error": f"line {a} past EOF ({len(all_lines)} lines)"}, 400)
        chunk = all_lines[a - 1:end]
        sha8 = hashlib.sha256("\n".join(s.rstrip() for s in chunk).encode()).hexdigest()[:8]
        try:
            etag = f'"{os.stat(path).st_mtime_ns:x}-{a}-{end}"'
        except OSError:
            etag = None
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            super().end_headers()
            return None
        return self._json({
            "src": key, "path": live, "snapshot": snapshot, "label": entry.get("label", os.path.basename(path)),
            "lang": entry.get("lang", "python"), "start": a, "end": end,
            "lines": chunk, "sha8": sha8, "nlines": len(all_lines),
        }, cache="public, max-age=300", etag=etag)

    # ---------- routing ----------

    def do_GET(self) -> None:
        u = urlparse(self.path)
        if u.path == "/api/src":
            return self._api_src(parse_qs(u.query))
        fp = self.translate_path(self.path)
        if os.path.isfile(fp):
            gz = self._gzip_file(fp)
            if gz is not None:
                st = os.stat(fp)
                etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.send_header("Content-Length", "0")
                    super().end_headers()
                    return None
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Encoding", "gzip")
                self.send_header("ETag", etag)
                self.send_header("Content-Length", str(len(gz)))
                super().end_headers()
                self.wfile.write(gz)
                return None
        return super().do_GET()

    def log_message(self, *a: Any) -> None:
        pass


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second process bind a port that is already
    # in use (requests then go to either one), so a busy port would not error.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


if __name__ == "__main__":
    n_keys = len(allowlist())
    log.info("model_atlas serving %s at http://%s:%d (%d source keys allowlisted, sources=%s)",
             ROOT, HOST, PORT, n_keys, SOURCES_MODE)
    if not n_keys:
        log.warning("no allowlist yet — run build_viz.py first, /api/src will 403")
    try:
        server = Server((HOST, PORT), H)
    except OSError as exc:
        log.error("cannot listen on %s:%d (%s) — is the port already in use? "
                  "Pass another port: serve.py 8878", HOST, PORT, exc)
        sys.exit(1)
    url = f"http://127.0.0.1:{PORT}/"
    log.info("open %s  (Ctrl+C to stop)", url)
    if os.environ.get("ATLAS_OPEN") == "1":
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopped")
