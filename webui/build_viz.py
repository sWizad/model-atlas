#!/usr/bin/env python3
"""model_atlas builder: validate the diagram specs, bind them to real code, emit data/.

Pipeline:  load_specs -> validate -> resolve_config -> build_allowlist
           -> check_drift -> emit

Why each stage exists:
  resolve_config   expands {{cfg.*}} from the REAL checkpoint config.json, so a
                   diagram can never print a dim that contradicts the weights.
  build_allowlist  the only src keys /api/src will serve are the ones a diagram
                   actually references.
  check_drift      every code ref carries expect{symbol, first, sha}; when the
                   upstream file moves, this says MOVED (and --fix repairs the
                   line numbers from the symbol) instead of silently showing the
                   wrong lines.

Usage:
  python build_viz.py                 # validate + build data/
  python build_viz.py --check         # validate + drift report, emit nothing
  python build_viz.py --fix           # seal new refs / repair MOVED ones in place
  python build_viz.py --strict        # exit 1 on any verdict but OK/ABSENT
  python build_viz.py --model wan13b  # restrict to one model
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import logging
import os
import re
import sys
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ATLAS = os.path.dirname(HERE)
SPECS = os.path.join(ATLAS, "specs")
DATA = os.path.join(HERE, "data")
SOURCES_JSON = os.path.join(SPECS, "sources.json")

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
log = logging.getLogger("build_viz")

LEVEL_KEYS = {"id", "title", "short", "subtitle", "parent", "grid", "lanes", "rows",
              "nodes", "edges", "bands", "notes",
              "code",       # the level's OWN source — shown when nothing is selected
              "zoom_from",  # {level, node, label}: which box in the parent this level opens up
              "kind"}       # flow (default) | compare | gallery — see check_connectivity
KINDS = {"flow", "compare", "gallery"}
ZOOM_KEYS = {"level", "node", "label"}
NODE_KEYS = {"id", "lane", "row", "col", "cols", "laneSpan", "rowSpan", "title",
             "sublines", "dim", "stream", "state", "optional", "shape", "drill",
             "badge", "note", "code"}
EDGE_KEYS = {"from", "to", "kind", "ports", "label", "dashed", "head", "stream", "bow"}
BAND_KEYS = {"id", "rows", "lanes", "label", "dim", "style", "dashed", "selectable",
             "drill", "code", "note"}
NOTE_KEYS = {"row", "title", "text", "code"}
STATES = {"trainable", "frozen", "none"}
EDGE_KINDS = {"straight", "elbow", "curve", "bus"}

PLACEHOLDER = re.compile(r"\{\{([a-zA-Z0-9_.]+)\}\}")


class SpecError(Exception):
    """A spec that cannot be rendered. Always names model/level/element."""


# --------------------------------------------------------------- loading

def load_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise SpecError(f"missing file: {path}")
    except ValueError as exc:
        raise SpecError(f"{path}: invalid JSON: {exc}")


def load_specs(only: Optional[str] = None) -> dict[str, dict]:
    """-> {model_id: {"manifest": .., "levels": {level_id: level}, "dir": ..}}"""
    models: dict[str, dict] = {}
    for name in sorted(os.listdir(SPECS)):
        d = os.path.join(SPECS, name)
        if not os.path.isdir(d) or name.startswith("_"):
            continue
        if only and name != only:
            continue
        mpath = os.path.join(d, "model.json")
        if not os.path.exists(mpath):
            log.warning("%s: no model.json yet, skipping", name)
            continue
        manifest = load_json(mpath)
        levels = {}
        for lid in manifest.get("levels", []):
            lv = load_json(os.path.join(d, f"{lid}.json"))
            lv.setdefault("id", lid)
            levels[lv["id"]] = lv
        models[manifest["id"]] = {"manifest": manifest, "levels": levels, "dir": d}
        log.info("loaded %s (%d levels)", manifest["id"], len(levels))
    return models


# ------------------------------------------------------------ validation

def holders(lv: dict) -> list[dict]:
    """Everything on a level that may carry `code` refs — the level itself first."""
    return [lv] + lv.get("nodes", []) + lv.get("bands", []) + lv.get("notes", [])


def _unknown(where: str, obj: dict, allowed: set[str]) -> None:
    extra = set(obj) - allowed
    if extra:
        raise SpecError(f"{where}: unknown key(s) {sorted(extra)}")


def validate(models: dict[str, dict], sources: dict[str, dict]) -> None:
    for mid, m in models.items():
        streams = set(m["manifest"].get("streams", {}))
        level_ids = set(m["levels"])
        for lid, lv in m["levels"].items():
            w = f"{mid}/{lid}"
            _unknown(w, lv, LEVEL_KEYS)
            lanes = {l["id"] for l in lv.get("lanes", [])}
            rows = {r["id"] for r in lv.get("rows", [])}
            if len(lanes) != len(lv.get("lanes", [])):
                raise SpecError(f"{w}: duplicate lane id")
            if len(rows) != len(lv.get("rows", [])):
                raise SpecError(f"{w}: duplicate row id")
            if lv.get("parent") and lv["parent"] not in level_ids:
                raise SpecError(f"{w}: parent '{lv['parent']}' is not a level of {mid}")
            _check_code(f"{w}: level overview", lv.get("code", []), sources)
            if lv.get("kind", "flow") not in KINDS:
                raise SpecError(f"{w}: kind must be one of {sorted(KINDS)}")
            z = lv.get("zoom_from")
            if z:
                _unknown(f"{w}: zoom_from", z, ZOOM_KEYS)
                if z["level"] not in level_ids:
                    raise SpecError(f"{w}: zoom_from.level '{z['level']}' is not a level")
                parent_lv = m["levels"][z["level"]]
                ids_up = ({n["id"] for n in parent_lv.get("nodes", [])} |
                          {b["id"] for b in parent_lv.get("bands", [])})
                if z["node"] not in ids_up:
                    raise SpecError(f"{w}: zoom_from.node '{z['node']}' is not on {z['level']}")

            ids: set[str] = set()
            for r in lv.get("rows", []):
                if r.get("compare") and lv.get("kind") != "compare":
                    raise SpecError(f"{w}: row '{r['id']}' has `compare` but the "
                                    f"level is not kind:\"compare\"")
            for n in lv.get("nodes", []):
                nw = f"{w}: node '{n.get('id', '?')}'"
                _unknown(nw, n, NODE_KEYS)
                if n["id"] in ids:
                    raise SpecError(f"{nw}: duplicate id")
                ids.add(n["id"])
                if n["lane"] not in lanes:
                    raise SpecError(f"{nw}: unknown lane '{n['lane']}'")
                if n["row"] not in rows:
                    raise SpecError(f"{nw}: unknown row '{n['row']}'")
                if n.get("stream") and n["stream"] not in streams:
                    raise SpecError(f"{nw}: unknown stream '{n['stream']}'")
                if n.get("state", "none") not in STATES:
                    raise SpecError(f"{nw}: state must be one of {sorted(STATES)}")
                if n.get("drill") and n["drill"] not in level_ids:
                    raise SpecError(f"{nw}: drill target '{n['drill']}' is not a level")
                _check_code(nw, n.get("code", []), sources)

            # Two nodes in one cell render on top of each other - the reader
            # sees one box and never knows the other exists.
            cells: dict[tuple, str] = {}
            for n in lv.get("nodes", []):
                key = (n["lane"], n["row"], n.get("col", 0))
                if key in cells:
                    raise SpecError(
                        f"{w}: nodes '{cells[key]}' and '{n['id']}' both sit at "
                        f"lane={key[0]} row={key[1]} col={key[2]} - they would overlap. "
                        f"Give them col/cols, or put one in its own row.")
                cells[key] = n["id"]

            for b in lv.get("bands", []):
                bw = f"{w}: band '{b.get('id', '?')}'"
                _unknown(bw, b, BAND_KEYS)
                if b["id"] in ids:
                    raise SpecError(f"{bw}: id collides with a node")
                ids.add(b["id"])
                for r in b.get("rows", []):
                    if r not in rows:
                        raise SpecError(f"{bw}: unknown row '{r}'")
                if b.get("lanes") != "*":
                    for l in b.get("lanes", []):
                        if l not in lanes:
                            raise SpecError(f"{bw}: unknown lane '{l}'")
                if b.get("drill") and b["drill"] not in level_ids:
                    raise SpecError(f"{bw}: drill target '{b['drill']}' is not a level")
                _check_code(bw, b.get("code", []), sources)

            for e in lv.get("edges", []):
                ew = f"{w}: edge {e.get('from')}->{e.get('to')}"
                _unknown(ew, e, EDGE_KEYS)
                for side in ("from", "to"):
                    if e[side] not in ids:
                        raise SpecError(f"{ew}: '{e[side]}' is not a node or band on this level")
                if e.get("kind", "straight") not in EDGE_KINDS:
                    raise SpecError(f"{ew}: kind must be one of {sorted(EDGE_KINDS)}")

            for nt in lv.get("notes", []):
                ntw = f"{w}: note '{nt.get('title', '?')}'"
                _unknown(ntw, nt, NOTE_KEYS)
                if nt.get("row") and nt["row"] not in rows:
                    raise SpecError(f"{ntw}: unknown row '{nt['row']}'")
                _check_code(ntw, nt.get("code", []), sources)
        log.info("validated %s", mid)


def check_connectivity(models: dict[str, dict]) -> int:
    """On a `flow` level every lane must reach every other lane.

    Three columns that never touch are three separate pictures sharing a page —
    the reader gets no story about how the streams combine. A level that really
    is a side-by-side or a gallery says so with kind:"compare"/"gallery" and is
    exempt; anything else is a flow that forgot to converge.
    """
    warned = 0
    for mid, m in models.items():
        for lid, lv in m["levels"].items():
            if lv.get("kind", "flow") != "flow":
                continue
            lanes = [l["id"] for l in lv.get("lanes", [])]
            if len(lanes) < 2:
                continue
            parent = {l: l for l in lanes}

            def find(x: str) -> str:
                while parent[x] != x:
                    parent[x] = parent[parent[x]]
                    x = parent[x]
                return x

            def union(a: str, b: str) -> None:
                parent[find(a)] = find(b)

            lane_of = {n["id"]: n["lane"] for n in lv.get("nodes", [])}
            bands = {b["id"]: b for b in lv.get("bands", [])}
            spanned_of = (lambda b: lanes if b.get("lanes") == "*" else b["lanes"])
            for b in bands.values():
                sp = spanned_of(b)
                for l in sp[1:]:
                    union(sp[0], l)
            for e in lv.get("edges", []):
                la, lb = lane_of.get(e["from"]), lane_of.get(e["to"])
                if la and lb:
                    union(la, lb)
                for end, other in ((e["from"], lb), (e["to"], la)):
                    if end in bands and other:
                        for l in spanned_of(bands[end]):
                            union(l, other)
            groups: dict[str, list[str]] = {}
            for l in lanes:
                groups.setdefault(find(l), []).append(l)
            if len(groups) > 1:
                log.warning("connectivity: %s/%s is kind:flow but its lanes never "
                            "meet — %s are separate pictures. Add the row where they "
                            "converge, or set kind to compare/gallery.",
                            mid, lid, list(groups.values()))
                warned += 1
    return warned


def check_continuity(models: dict[str, dict]) -> int:
    """A box that opens a level promises that level is ABOUT that box.

    The cheap, checkable proxy: the child level's own `code` must share a source
    file with the box that drills into it. When it does not, the reader clicks a
    box about one thing and lands on a diagram about another — which is exactly
    how `L1_pipeline.loop` (the sampling loop, in text2video.py) ended up opening
    a level about patch embedding in model.py. Warning, not an error: a legitimate
    call-site -> definition hop across files is caught by giving the box a ref to
    the callee, which is what you want it to have anyway.
    """
    warned = 0
    for mid, m in models.items():
        for lid, lv in m["levels"].items():
            for h in lv.get("nodes", []) + lv.get("bands", []):
                target = h.get("drill")
                if not target:
                    continue
                child = m["levels"][target]
                psrc = {r["src"] for r in h.get("code", [])}
                csrc = {r["src"] for r in child.get("code", [])}
                if not csrc:
                    log.warning("continuity: %s/%s '%s' opens %s, which has no "
                                "overview code to compare against",
                                mid, lid, h.get("id"), target)
                    warned += 1
                elif not (psrc & csrc):
                    log.warning("continuity: %s/%s '%s' cites %s but opens %s, "
                                "which is about %s — the subject changes on click",
                                mid, lid, h.get("id"), sorted(psrc) or "nothing",
                                target, sorted(csrc))
                    warned += 1
    return warned


def _check_code(where: str, refs: list[dict], sources: dict[str, dict]) -> None:
    for r in refs:
        if r["src"] not in sources:
            raise SpecError(f"{where}: unknown src key '{r['src']}' "
                            f"(add it to specs/sources.json)")
        a, b = r["lines"]
        if a < 1 or b < a:
            raise SpecError(f"{where}: bad line range {a}-{b}")


# ------------------------------------------------------------- config

def resolve_config(models: dict[str, dict]) -> None:
    """Load each model's real config.json and expand {{cfg.*}} everywhere."""
    for mid, m in models.items():
        env: dict[str, Any] = {}
        for src in m["manifest"].get("config_from", []):
            alias, path = src["as"], src["path"]
            try:
                cfg = load_json(path)
            except SpecError as exc:
                log.warning("%s: config %s unreadable (%s) — {{%s.*}} will fail",
                            mid, path, exc, alias)
                continue
            for k, v in cfg.items():
                env[f"{alias}.{k}"] = v
        keep = m["manifest"].get("config_keys", [])
        m["config"] = {k: env[f"cfg.{k}"] for k in keep if f"cfg.{k}" in env}
        m["config_missing"] = [k for k in keep if f"cfg.{k}" not in env]
        if m["config_missing"]:
            log.warning("%s: config keys not found in checkpoint config: %s",
                        mid, m["config_missing"])
        _expand(m["levels"], env, mid)


def _expand(obj: Any, env: dict[str, Any], where: str) -> Any:
    if isinstance(obj, str):
        def sub(mo: "re.Match[str]") -> str:
            key = mo.group(1)
            if key not in env:
                raise SpecError(f"{where}: unknown placeholder {{{{{key}}}}} "
                                f"(known: {sorted(env)[:8]}…)")
            return str(env[key])
        return PLACEHOLDER.sub(sub, obj)
    if isinstance(obj, list):
        return [_expand(v, env, where) for v in obj]
    if isinstance(obj, dict):
        for k, v in obj.items():
            obj[k] = _expand(v, env, where)
        return obj
    return obj


# ----------------------------------------------------------- allowlist

def build_allowlist(models: dict[str, dict], sources: dict[str, dict]) -> dict[str, dict]:
    used: set[str] = set()
    for m in models.values():
        for lv in m["levels"].values():
            for holder in holders(lv):
                for r in holder.get("code", []):
                    used.add(r["src"])
    allow = {}
    for k in sorted(used):
        s = dict(sources[k])
        s.pop("note", None)
        try:
            st = os.stat(s["path"])
            s["nlines"] = sum(1 for _ in open(s["path"], encoding="utf-8", errors="replace"))
            s["mtime"] = st.st_mtime
            s["present"] = True
        except OSError:
            s["present"] = False
            log.warning("source absent on this host: %s -> %s", k, s["path"])
        allow[k] = s
    log.info("allowlist: %d/%d source keys referenced", len(allow), len(sources) - 1)
    return allow


# --------------------------------------------------------------- drift

def symbol_map(path: str) -> dict[str, tuple[int, int]]:
    """Dotted qualname -> (lineno, end_lineno). Classes, funcs, and the
    `self.x = ...` assignments inside __init__ (so 'WanModel.patch_embedding'
    is a relocatable anchor, not just a line number)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        tree = ast.parse(f.read(), filename=path)
    out: dict[str, tuple[int, int]] = {}

    def walk(node: ast.AST, prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                q = f"{prefix}.{child.name}" if prefix else child.name
                out[q] = (child.lineno, child.end_lineno or child.lineno)
                walk(child, q)
            elif isinstance(child, (ast.Assign, ast.AnnAssign)) and prefix:
                owner = prefix.rsplit(".", 1)[0] if "." in prefix else prefix
                targets = child.targets if isinstance(child, ast.Assign) else [child.target]
                for t in targets:
                    if (isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name)
                            and t.value.id == "self"):
                        out.setdefault(f"{owner}.{t.attr}",
                                       (child.lineno, child.end_lineno or child.lineno))
            else:
                walk(child, prefix)

    walk(tree, "")
    return out


def snippet_sha(lines: list[str]) -> str:
    return hashlib.sha256("\n".join(s.rstrip() for s in lines).encode()).hexdigest()[:8]


def first_line(lines: list[str]) -> str:
    for s in lines:
        if s.strip():
            return s.strip()
    return ""


def check_drift(models: dict[str, dict], allow: dict[str, dict],
                fix: bool = False) -> list[dict]:
    """Verdict per code ref. With fix=True, seal new refs and repair MOVED ones."""
    cache: dict[str, tuple[list[str], dict[str, tuple[int, int]]]] = {}
    report: list[dict] = []
    dirty: set[str] = set()

    for mid, m in models.items():
        for lid, lv in m["levels"].items():
            for holder in holders(lv):
                hid = holder.get("id") or holder.get("title", "?")
                for r in holder.get("code", []):
                    v = _verdict(r, allow, cache, fix)
                    v.update(model=mid, level=lid, element=hid)
                    report.append(v)
                    if fix and (v["verdict"] in ("SEALED", "MOVED") or v.pop("touched", False)):
                        dirty.add(os.path.join(m["dir"], f"{lid}.json"))
                    v.pop("touched", None)

    if fix and dirty:
        for mid, m in models.items():
            for lid, lv in m["levels"].items():
                p = os.path.join(m["dir"], f"{lid}.json")
                if p in dirty:
                    with open(p, "w", encoding="utf-8") as f:
                        json.dump(lv, f, ensure_ascii=False, indent=2)
                        f.write("\n")
                    log.info("rewrote %s", os.path.relpath(p, ATLAS))

    # The page shows a DRIFT badge on a tab whose snippet may be the wrong lines.
    i = 0
    for m in models.values():
        for lv in m["levels"].values():
            for holder in holders(lv):
                for r in holder.get("code", []):
                    r["_v"] = report[i]["verdict"]
                    i += 1
    return report


def _verdict(r: dict, allow: dict[str, dict],
             cache: dict, fix: bool) -> dict:
    key = r["src"]
    entry = allow.get(key, {})
    path = entry.get("path", "?")
    base = {"src": key, "path": path, "lines": list(r["lines"])}

    if not entry.get("present"):
        return {**base, "verdict": "ABSENT", "detail": "file not on this host"}

    if key not in cache:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        cache[key] = (lines, symbol_map(path))
    lines, syms = cache[key]

    a, b = r["lines"]
    chunk = lines[a - 1:min(b, len(lines))]
    sha = snippet_sha(chunk)
    exp = r.get("expect") or {}

    # new ref, never sealed -> record what it points at now
    if not exp.get("sha"):
        sym = _enclosing(syms, a, b)
        if sym is None:
            # The range starts at a symbol but overshoots its end (an easy slip
            # when authoring by eye). Snap to the symbol so the ref stays
            # relocatable instead of being unanchored forever.
            starts = [q for q, (lo, _hi) in syms.items() if lo == a]
            if starts:
                sym = min(starts, key=lambda q: syms[q][1] - syms[q][0])
                a, b = syms[sym]
                chunk = lines[a - 1:min(b, len(lines))]
                sha = snippet_sha(chunk)
                if fix:
                    r["lines"] = [a, b]
                    base["lines"] = [a, b]
        if fix:
            r["expect"] = {"symbol": sym, "first": first_line(chunk), "sha": sha}
            if sym and sym in syms:
                r["expect"]["span"] = list(syms[sym])
        return {**base, "verdict": "SEALED" if fix else "UNSEALED",
                "symbol": sym, "detail": "run --fix to record symbol+sha"}

    if sha == exp["sha"]:
        # backfill the symbol span on refs sealed before spans were recorded
        sym_ok = exp.get("symbol")
        touched = False
        if fix and not exp.get("span") and sym_ok in syms:
            exp["span"] = list(syms[sym_ok])
            touched = True
        return {**base, "verdict": "OK", "symbol": sym_ok, "touched": touched}

    sym = exp.get("symbol")
    span = syms.get(sym) if sym else None
    if sym and not span:
        return {**base, "verdict": "GONE", "symbol": sym,
                "detail": f"symbol '{sym}' no longer exists in {os.path.basename(path)}"}

    # relocate: find the expected first line verbatim inside the symbol's new span
    want = exp.get("first", "")
    if span and want:
        lo, hi = span
        for i in range(lo, min(hi, len(lines)) + 1):
            if lines[i - 1].strip() == want:
                delta = i - a
                na, nb = a + delta, b + delta
                nchunk = lines[na - 1:min(nb, len(lines))]
                nsha = snippet_sha(nchunk)
                if fix:
                    r["lines"] = [na, nb]
                    r.setdefault("expect", {})["sha"] = nsha
                    r["expect"]["span"] = list(span)
                return {**base, "verdict": "MOVED", "symbol": sym,
                        "new_lines": [na, nb], "detail": f"shifted by {delta:+d} lines"}

    return {**base, "verdict": "CHANGED", "symbol": sym,
            "detail": "symbol found but its text changed — re-read and re-author this ref"}


def _enclosing(syms: dict[str, tuple[int, int]], a: int, b: int) -> Optional[str]:
    """The tightest symbol whose span contains [a, b]."""
    best, best_size = None, 10 ** 9
    for q, (lo, hi) in syms.items():
        if lo <= a and b <= hi and (hi - lo) < best_size:
            best, best_size = q, hi - lo
    return best


# ---------------------------------------------------------------- emit

def emit(models: dict[str, dict], allow: dict[str, dict], report: list[dict]) -> None:
    os.makedirs(DATA, exist_ok=True)
    stale = [r for r in report if r["verdict"] not in ("OK", "ABSENT")]

    for fn in os.listdir(DATA):
        if fn.endswith(".json"):
            os.remove(os.path.join(DATA, fn))

    index = {"built_utc": __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z",
             "models": [], "stale_refs": len(stale)}
    for mid, m in models.items():
        man = m["manifest"]
        index["models"].append({
            "id": mid, "name": man["name"], "family": man.get("family", ""),
            "root": man.get("root"), "config": m.get("config", {}),
            "levels": [{"id": lid, "title": lv.get("title", lid),
                        "short": lv.get("short", lv.get("title", lid)),
                        "parent": lv.get("parent"),
                        "n_nodes": len(lv.get("nodes", []))}
                       for lid, lv in m["levels"].items()],
            "stale_refs": len([r for r in stale if r["model"] == mid]),
        })
        with open(os.path.join(DATA, f"{mid}.json"), "w", encoding="utf-8") as f:
            json.dump({"manifest": man, "config": m.get("config", {}),
                       "levels": m["levels"]}, f, ensure_ascii=False)

    for name, obj in (("index.json", index), ("allowlist.json", allow),
                      ("drift.json", report)):
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2 if name != "index.json" else None)
    log.info("emitted data/ (%d models, %d source keys, %d stale refs)",
             len(models), len(allow), len(stale))


def print_report(report: list[dict]) -> None:
    counts: dict[str, int] = {}
    for r in report:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    log.info("drift: %s", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "no refs")
    for r in report:
        if r["verdict"] == "OK":
            continue
        log.warning("  %-8s %s/%s %-16s %s:%s-%s  %s", r["verdict"], r["model"],
                    r["level"], r["element"], r["src"], *r["lines"],
                    r.get("detail", ""))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="validate + drift only, emit nothing")
    ap.add_argument("--fix", action="store_true", help="seal new refs / repair MOVED line numbers")
    ap.add_argument("--strict", action="store_true", help="exit 1 on any verdict but OK/ABSENT")
    ap.add_argument("--model", help="restrict to one model id (= specs dir name)")
    args = ap.parse_args()

    try:
        sources = load_json(SOURCES_JSON)
        models = load_specs(args.model)
        if not models:
            log.error("no model specs found under %s", SPECS)
            return 1
        validate(models, sources)
        allow = build_allowlist(models, sources)
        # Drift runs on the RAW specs: --fix writes them back to disk, and the
        # {{cfg.*}} placeholders must survive that round-trip. Expansion is the
        # last step before emit, so only data/ ever holds resolved values.
        report = check_drift(models, allow, fix=args.fix)
        n_cont = check_continuity(models) + check_connectivity(models)
        resolve_config(models)
    except SpecError as exc:
        log.error("%s", exc)
        return 1

    print_report(report)
    if not args.check:
        emit(models, allow, report)
    bad = [r for r in report if r["verdict"] not in ("OK", "ABSENT")]
    if n_cont and args.strict:
        log.error("%d structural warning(s) and --strict given", n_cont)
        return 1
    if bad and args.strict:
        log.error("%d ref(s) not OK and --strict given", len(bad))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
