#!/usr/bin/env python3
"""Render checks for model_atlas — the things curl cannot see.

The playbook (§1) says a page must be tested in a real browser, because
`curl` happily passes on a visually broken page. These are the failures that
actually happened here and would otherwise ship silently:

  * the loading overlay never hides (a stale app.js, a bad fetch)
  * an arrow starts or ends in empty space, anchored off its own box
  * a box is selected but no source lines load
  * the page scrolls sideways at laptop width

Usage:  /root/miniconda3/envs/ltx2/bin/python check_render.py [PORT] [MODEL]
Exits non-zero on any failure.
"""
from __future__ import annotations

import json
import logging
import sys
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("check_render")

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8877
MODEL = sys.argv[2] if len(sys.argv) > 2 else None

# every arrow must touch the boxes it claims to join
EDGE_JS = """() => {
  const bad = [];
  const rectOf = (id) => {
    const g = document.querySelector(`#cam [data-id="${CSS.escape(id)}"]`);
    const r = g && g.querySelector('rect');
    return r ? {x:+r.getAttribute('x'), y:+r.getAttribute('y'),
                w:+r.getAttribute('width'), h:+r.getAttribute('height')} : null;
  };
  const near = (r,x,y,t) => x>=r.x-t && x<=r.x+r.w+t && y>=r.y-t && y<=r.y+r.h+t;
  document.querySelectorAll('#cam .eg').forEach(g => {
    const from=g.getAttribute('data-from'), to=g.getAttribute('data-to');
    const p=g.querySelector('path'); if(!p) return;
    const L=p.getTotalLength(), a=p.getPointAtLength(0), b=p.getPointAtLength(L);
    const ra=rectOf(from), rb=rectOf(to);
    if (ra && !near(ra,a.x,a.y,2)) bad.push(`${from}->${to}: START off the '${from}' box`);
    if (rb && !near(rb,b.x,b.y,2)) bad.push(`${from}->${to}: END off the '${to}' box`);
  });
  return bad;
}"""

STATE_JS = """() => ({
  overlay: !document.getElementById('loading').hidden,
  nodes: document.querySelectorAll('#cam .nd').length,
  edges: document.querySelectorAll('#cam .eg').length,
  codeLines: document.querySelectorAll('#code .ln').length,
  hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
})"""


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log.error("playwright is not installed in this env; "
                  "use /root/miniconda3/envs/ltx2/bin/python")
        return 2

    base = f"http://127.0.0.1:{PORT}"
    try:
        with urllib.request.urlopen(f"{base}/data/index.json", timeout=5) as r:
            index = json.load(r)
    except OSError as exc:
        log.error("cannot reach %s (%s) — is serve.py running?", base, exc)
        return 2

    models = [m for m in index["models"] if not MODEL or m["id"] == MODEL]
    if not models:
        log.error("model %r not in index.json", MODEL)
        return 2

    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        for m in models:
            for lv in m["levels"]:
                lid = lv["id"]
                page.goto(f"{base}/#/{m['id']}/{lid}", wait_until="domcontentloaded")
                page.wait_for_timeout(1400)
                st = page.evaluate(STATE_JS)
                bad = page.evaluate(EDGE_JS)
                probs = []
                if st["overlay"]:
                    probs.append("loading overlay never hid")
                if not st["nodes"]:
                    probs.append("no nodes rendered")
                if not st["codeLines"]:
                    probs.append("no overview code loaded")
                if st["hscroll"]:
                    probs.append("page scrolls sideways")
                probs += bad
                status = "ok" if not probs else "FAIL"
                log.info("%-7s %s/%-13s %2d nodes %2d edges %3d code lines",
                         status, m["id"], lid, st["nodes"], st["edges"], st["codeLines"])
                for q in probs:
                    log.error("          %s", q)
                    fails += 1

        # one narrow-width pass; the header is what usually overflows
        page.set_viewport_size({"width": 900, "height": 900})
        page.goto(f"{base}/#/{models[0]['id']}/{models[0]['root']}",
                  wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        if page.evaluate("document.documentElement.scrollWidth > "
                         "document.documentElement.clientWidth + 1"):
            log.error("page scrolls sideways at 900px")
            fails += 1
        else:
            log.info("ok      900px: no horizontal page scroll")

        if errors:
            for e in errors:
                log.error("JS error: %s", e)
            fails += len(errors)
        browser.close()

    log.info("RENDER: %s", "PASS" if not fails else f"FAIL ({fails})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
