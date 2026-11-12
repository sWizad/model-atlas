# model_atlas — architecture diagrams bound to the code that implements them

**Owner:** Teng. Running log: [`hub.md`](hub.md).

Reading a model's source to understand its architecture takes hours and the
understanding does not survive the week. This is the other way round: a diagram
you can *check*. Click any box, band or note and the **real source lines that
implement it** load in the side panel, read live off the build host's disk (or, anywhere else,
from the snapshots in `sources/`).

## Run it (Windows / any machine)

Needs **Python 3.9+** and nothing else (stdlib only, no `pip install`).

- **Windows:** double-click `start_webui.bat` (optional argument: a port, e.g.
  `start_webui.bat 8878`). It finds `py -3` or `python`, binds `127.0.0.1` only,
  and opens the browser.
- **Anywhere:** `python webui/serve.py`, then open the URL it prints.
  It binds `0.0.0.0` by default; set `ATLAS_HOST=127.0.0.1` to keep it local.
- **Port:** with no argument it uses the first free port in 8877-8886 (8877 may
  already be taken, e.g. by an IDE forwarding a remote instance). A port given
  as an argument is used as-is, and the server exits if it is busy.

The diagrams (`webui/data/`) are committed, and the code panel reads the cited
files from `sources/` whenever their build-host path does not exist, so a fresh
checkout works offline with no model code installed.

| env var | default | |
|---|---|---|
| `ATLAS_SOURCES` | `auto` | `auto`: read the live path from `specs/sources.json`, fall back to `sources/<key>.py` · `snapshot`: always `sources/` · `live`: never fall back (404 if absent). `/api/src` reports which one it used as `"snapshot": true/false`. |
| `ATLAS_HOST` | `0.0.0.0` | bind address |
| `ATLAS_OPEN` | unset | `1` opens a browser once the port is bound |

## Rebuild (build host only)

Rebuilding needs the checkpoint `config.json` files named in each
`specs/<model>/model.json` and the live source paths in `specs/sources.json`,
which exist only on the build host. Elsewhere, just serve the committed build.

```bash
PY=/root/miniconda3/envs/ltx2/bin/python
$PY webui/build_viz.py            # validate specs + bind them to code -> webui/data/
$PY webui/snapshot_sources.py     # REQUIRED after every rebuild: refresh sources/ to match the new line refs
$PY webui/serve.py 8877           # http://127.0.0.1:8877
$PY webui/check_render.py [PORT [MODEL]]   # browser checks (needs playwright; run after any renderer change)
```

If you rebuild but skip `snapshot_sources.py`, other machines show the old file
under the new line numbers.

Verification is two halves, and both matter:

| | catches |
|---|---|
| `build_viz.py --check --strict` | stale/moved line refs, dangling ids, a drill that changes the subject, a flow level whose lanes never converge |
| `check_render.py` | what curl cannot see: a stuck loading overlay, an arrow anchored off its box, a level with no code, sideways scroll |

## What is in it

| Model | Levels | Diagram source of truth |
|---|---|---|
| **Wan2.1-T2V-1.3B** | all 6 | `Wan2.2/wan/modules/model.py` (+ `attention.py`, `vae2_1.py`, `t5.py`, `text2video.py`) |
| **MiniMax-H3** | all 6 | `VideoX-Fun/.../minimax_h3_transformer3d.py` (+ `pipeline_minimax_h3.py`, `minimax_h3_vae.py`, SGLang serving impl) |
| gemma-4-31B-it | — | `transformers/models/gemma4/modeling_gemma4.py` (+ vLLM as a 2nd code tab) |

## The level ladder

Each level drills into the next; the breadcrumb and the rail both navigate, and
every level is deep-linkable as `#/<model>/<level>/<node>`.

| # | Level | Answers |
|---|---|---|
| 1 | **Sampling pipeline** | what runs once vs. once per step |
| 2 | **Inside one denoising step** | the loop body: two forward passes, the CFG mix, one scheduler step |
| 3 | **How three things become tokens** | latent, text and timestep side by side, with every shape |
| 4 | **The block stack** | what the 30 blocks share vs. what each owns |
| 5 | **Inside one block — the exact order** | the 13 steps: norm → modulate → self-attn → gated add → norm → cross-attn → plain add → norm → modulate → MLP → gated add |
| 6 | **Attention level — self vs cross** | the two attentions in parallel columns; exactly three differences |
| 7 | **Sub-operations** | 3D RoPE construction and application, the attention-kernel fallback, head + unpatchify |

**Gemma-4-31B** has six: Pipeline → **Vision** (any image → exactly 280 pooled
soft tokens) → **Layer stack** (the 5 sliding : 1 full pattern) → Layer order
(four norms per layer) → **Attention** (sliding vs full side by side — they are
not the same operation with a different mask) → Sub-ops.

Reading the three together is the point. Wan conditions every block on the
timestep and cross-attends text. H3 puts every modality in one sequence and
looks modulation up per row. Gemma has no conditioning at all — it varies the
*layers* instead, alternating two attention geometries.

**Qwen3.8-27B** has six: Pipeline → Vision → **Layer stack** (3 linear : 1 full)
→ Layer order → **Mixers** (GatedDeltaNet vs attention side by side — two
different algorithms, not two configs of one) → Sub-ops. It is architecturally
identical to Qwen3.5-27B; the on-disk Qwen family splits into four unrelated
architectures, see `hub.md`.

Still to come: cross-model **Mechanisms** pages (AdaLN, RoPE, QK-norm, GQA,
SwiGLU, flow matching).

## Moving around

The diagram is a canvas, not a scrolling page.

| | |
|---|---|
| pan | drag anywhere, or the wheel (shift+wheel for horizontal), or the arrow keys |
| zoom | ctrl/cmd + wheel at the cursor, or the `+` / `-` buttons, or the `+` / `-` keys |
| fit | the `⤢` button, `0`, or double-click empty space — toggles whole-diagram / fit-width |
| drill in | double-click a box that says `opens → …`, or use the level rail |
| go back up | click the zoom lens at the top, or the breadcrumb |
| resize the code panel | drag the gutter between the two halves; double-click it to reset. The width is remembered. |

## Layout

```
specs/sources.json     src key -> the real file on disk. Specs may reference ONLY these keys.
specs/<model>/model.json      manifest: name, streams+tones, which config.json to read, level list
specs/<model>/<level>.json    the diagram: lanes x rows grid, nodes, bands, edges, notes
webui/build_viz.py     validate -> allowlist -> drift check -> data/
webui/serve.py         static (HTTP/1.1, no-cache, gzip) + GET /api/src
webui/diagram.js       the generic lane x row SVG renderer (no layout algorithm)
webui/hl.js            ~90-line Python highlighter, no CDN
webui/app.js           boot, hash routing, selection, the code panel
webui/snapshot_sources.py   copy every file in specs/sources.json -> sources/<key>.py
webui/data/            GENERATED by build_viz.py, but COMMITTED (rebuilding needs build-host checkpoints)
sources/               snapshots of the cited upstream files; provenance + licences in sources/README.md
start_webui.bat        Windows launcher
```

## How to add a model

1. `specs/sources.json` — add a `src` key for each file you will cite.
2. `specs/<id>/model.json` — `name`, `config_from` (a real checkpoint `config.json`),
   `config_keys`, `streams` (id → `{label, tone}`), `levels`, `root`.
3. `specs/<id>/<level>.json` — give the level a `short` name, its own
   `code: []` (the function the level draws — shown when nothing is selected)
   and, unless it is the root, `zoom_from: {level, node, label}` naming the box
   one level up that it opens. Set `kind` to `compare` or `gallery` if the
   columns are deliberately independent (a `flow` level must converge, and the
   build enforces it); on a `compare` level tag rows `compare: "same"|"differs"`. Then declare `lanes` and `rows`, and place `nodes` at
   `{lane, row}`. Add `bands` for things that span lanes (the dark full-width
   attention bar is `{"lanes":"*","style":"dark"}`), `edges` between any two ids,
   `notes` in a `kind:"footer"` row. Give each element a `code: [{role, src, lines}]`.
   Write dims as `{{cfg.dim}}` — they are filled from the checkpoint at build time,
   so a diagram can never print a number the weights contradict.
4. `build_viz.py --fix` seals every ref with its enclosing symbol + a sha, then
   `snapshot_sources.py` copies the new file into `sources/`. Done.

## Drift — why the line numbers stay honest

Each code ref stores `expect: {symbol, first, sha, span}`. `build_viz.py --check`
re-resolves it with `ast`:

| verdict | meaning |
|---|---|
| `OK` | the snippet is byte-identical |
| `MOVED` | the symbol moved — `--fix` repairs the line numbers and prints what it did |
| `CHANGED` | the symbol's text changed; re-read and re-author that ref |
| `GONE` | the symbol no longer exists — hard error |
| `ABSENT` | the file is not on this host (another env/pod) — warning only |

**Continuity.** `build_viz.py` also checks that a box which opens a level cites
the same source file as that level's overview `code`. A box saying one thing and
opening a diagram about another is the single worst failure mode of a drill-down
atlas, and this catches it at build time (`--strict` makes it fatal).

`--strict` exits non-zero on anything but `OK`/`ABSENT`. The page shows a
`DRIFT` badge on any tab whose snippet may be the wrong lines. Run `--check`
after any upstream `pip install -U` or vendor-tree edit.

## Conventions this follows

`documents/webui/webui_tool_playbook.md` (in the `temporal-caption-sg` repo, not this one): `[hidden]{display:none!important}`,
versioned `?v=N` assets, on-screen loading status + a 9 s inline watchdog +
`window.onerror`/`unhandledrejection`, stdlib `ThreadingHTTPServer` with
`protocol_version="HTTP/1.1"`, `no-cache` (never `no-store`), whole-body gzip
≥32 KB. `/api/src` serves only allowlist **keys**, never a client-supplied path.
Nothing heavy is generated, so there is no `_data` symlink (`temporal-caption-sg`
CLAUDE.md §5 is satisfied by construction).
