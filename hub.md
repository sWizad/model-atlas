# model_atlas — hub

**Owner:** Teng. Reverse-chron, newest first. Pointer-style: link, don't restate.

## 2026-11-12 14:53 — split into a standalone repo, runs off the build host

- Copied out of `AB_test/other/model_atlas/` (source untouched) into its own git repo. `webui/data/` is now **committed**; the 16 cited files are snapshotted to [`sources/`](sources/README.md) (provenance + licences) by `webui/snapshot_sources.py`.
- `serve.py`: `ATLAS_SOURCES=auto|snapshot|live`, `ATLAS_HOST`, `ATLAS_OPEN`, explicit MIME map, clean busy-port error (incl. Windows). `start_webui.bat` for Windows. Verified: 404/404 `/api/src` requests snapshot == live, `check_render` PASS ×4 — see [README § Run it](README.md#run-it-windows--any-machine).

## 2026-10-08 (j) — Qwen3.8-27B. Four models, 470 refs.

`#/qwen38_27b/Q1_pipeline`. **470 refs across four models, 100% anchored.**

First, the survey Teng asked for: the 8 Qwen checkpoints on disk are **four
unrelated architectures**, not one family —
`qwen2_vl`/`qwen2_5_vl` (legacy) · `qwen3_vl`(+`_moe`) (dense/MoE VLM, deepstack,
interleaved mRoPE) · `qwen3_5`(+`_moe`) (hybrid linear/full) . **Qwen3.5-27B and
Qwen3.8-27B are architecturally identical** — deltas are `output_gate_type`
"swish", explicit `partial_rotary_factor`, untied embeddings and a new
tokenizer. Qwen3-VL-8B is 12 MB of dangling symlinks into an unmounted mount.

- **Q5_mixers is the level.** GatedDeltaNet (48 layers) vs Qwen3_5Attention (16)
  in two columns with same/differs chips: four projections vs a double-width
  `q_proj` chunked into q+gate; a width-4 causal conv and **no positional
  encoding at all** vs QK-norm + interleaved mRoPE; a gated delta rule with a
  **fixed 48×128×128 state** vs softmax attention; O(1) vs O(T) memory. They
  agree only on input, output gating and output width.
- Also drawn: the plainest block in the atlas (two norms, plain adds), the
  **MTP head that transformers drops on load** (`^mtp.*`), and the fact that
  vLLM *imports* Qwen3-VL's ViT rather than reimplementing it.
- Two honest caveats on the page: the HF qwen3_5 code has **no deepstack path
  at all** (not "switched off"), and this transformers version hardcodes
  `sigmoid` for the attention output gate while the 3.8 config asks for swish.
- Audit caught 11 bad refs + 3 unanchored (module-level import, a license
  header, a docstring middle) and one **wrong claim** in a note. All corrected.

## 2026-10-08 (i) — gemma-4-31B-it, all six levels. Three models in.

`#/gemma4_31b/G1_pipeline`. **369 refs across all three models, 100% anchored.**

- Levels: Pipeline → Vision → Layer stack → Layer order → Attention → Sub-ops.
- **G5_attention is the payoff for the `kind: compare` work.** Sliding and full
  layers sit in two columns with a same/differs chip per row, and they differ in
  far more than the mask: head_dim 256 vs **512**, 16 vs **4** KV heads, an own
  `v_proj` vs **V = K** (`attention_k_eq_v`), rope θ=1e4 full-rotation vs
  θ=1e6 with `partial_rotary_factor 0.25`. Same input, same three norms
  (q/k/**v**-norm — the V-norm is unusual and scale-free), same o_proj target.
- **G4_layer**: four RMSNorms per layer, not two — each sublayer is normalised
  on the way in *and* on the way out, before the residual add. Plus the MoE and
  per-layer-input branches that exist in the code and are off in this config.
- **G2_multimodal**: a parameter-free 3×3 average pool to a FIXED 280 soft
  tokens, the opposite trade to Qwen3-VL's learned patch merger — cost per image
  is constant regardless of resolution.
- Audit caught **16 bad refs** again, same classes as before: `lm_head`/softcap
  refs landing mid-argument-list, the "decoder loop" pointing at
  `get_per_layer_inputs` instead of the actual loop at `:1619`, the final-norm
  ref pointing at the layer list one line above it, and a vLLM range starting
  2 lines before its class. All corrected and re-sealed.

## 2026-10-08 (h) — H3 conditioning: keyframes and references

Teng asked for the keyframe / reference input path. New level
**`H2b_conditioning` — Keyframes & references**, between Packing and the stack.

The point it makes: **a conditioning row is an ordinary video row.** Same
`proj_in`, same `token_tag` (video), same 50 blocks, same attention. There is
no ref_type embedding, no extra channel, no second branch. Only two things
differ, and the level is laid out as those two columns converging into a dark
"IDENTICAL FROM HERE" band and then splitting again:

1. **its position** — FL2VA pins a keyframe to the anchor time `"first"` or
   `"last"` with the *same* (h, w) grid as a real frame, so it occupies exactly
   the rotary coordinate of the frame it constrains; Ref2VA instead lets each
   reference advance the shared clock (image → 1 slot, audio → its latent count,
   video → `max(soundtrack, video span)`).
2. **its timestep** — pinned at the conditioning level while the target rows
   step down. `torch.unique(row_timesteps, return_inverse=True)` turns that into
   the `(timestep, timestep_indices)` pair — which is *why* the transformer takes
   a vector of timesteps at all, and feeds straight into `adaln_indices`.

Also drawn: conditioning rows are **noise-augmented to t = 0.999, not clean**
(and their noise is the first draw off the generator, so seed reproducibility
depends on it), and the scheduler never writes them —
`latents[num_condition_video_rows:] = step(...)`.

`H2_packing` gained the optional conditioning row that opens this level.
263 refs across both models, all OK; continuity, connectivity and render clean.

## 2026-10-08 (g) — MiniMax-H3, all six levels

Second model in. `#/minimax_h3/H1_pipeline`. 230 refs across both models, all OK.

- Levels mirror Wan's questions so the two can be read against each other:
  **Pipeline → Packing → Block stack → Block order → Attention → Sub-ops**.
- **H2_packing is the one to read.** Video / audio / text rows are projected to
  the same width and `index_copy`'d into ONE flat buffer; after that row nothing
  in the model knows which modality it is looking at except `token_tags`. The
  three lanes converge into the scatter band, as the connectivity rule requires.
- Contrasts with Wan, drawn explicitly on the levels where they bite:
  no cross-attention at all (text is *in* the sequence); AdaLN taps selected
  per row by `timestep_indices * 3 + token_tags` instead of broadcast;
  RMSNorm not LayerNorm; SwiGLU not GELU; two output heads; partial rotary
  (96 of 128 head channels) instead of Wan's full-head rotation; attention
  inner dim 7168 > hidden 5376.
- Sources: `mmx.dit` (VideoX-Fun, the readable one), `mmx.pipe` (builds the
  packed sequence), `mmx.vae`, `mmx.sglang` (what fl2va actually serves, cited
  on the levels where the two diverge).
- **The ref audit paid for itself again**: 12 refs were wrong on first pass —
  three pointed at the `forward` signature instead of the docstring describing
  the tensor, four projection call sites were one line early (line 681 is a
  comment), and two "overview" refs pointed at a signature rather than the
  sampling loop. All corrected; 103/103 H3 refs anchor to a real symbol.

## 2026-10-08 (f) — back to a real canvas, and a draggable split

- **Canvas, not a scroller.** The fit-to-width + scrolling stage from (b) fixed
  readability but lost the canvas feel. The viewport is now fixed and the
  **viewBox moves over the drawing**: no scrollbars, text crisp at any zoom
  (it is a vector transform, not a scaled bitmap). Opening a level still fits
  the WIDTH — the thing that made letterboxing unusable on a 13-row diagram.
  Drag anywhere to pan, wheel pans, ctrl/cmd+wheel zooms at the cursor,
  double-click empty space or `0` toggles fit-all / fit-width, arrows pan.
  Zoom range 0.15×–6×.
- **Resizable code panel.** A gutter between the diagram and the panel: drag to
  trade diagram width for code width, double-click to reset, arrow keys when
  focused, clamped to [300, viewport−420], persisted in `localStorage`
  (`atlas.side`). The canvas re-fits its viewBox as the split moves. Inert in
  the stacked (<1080px) layout, where the panels are rows.
- Two bugs caught by `check_render.py` while doing it: the gutter's wider hit
  area (`inset:0 -4px`) pushed the page sideways at 900px, and the initial fit
  ran while `#app` was still hidden so every level opened at ~0.07× zoom. Both
  fixed; the fit is now deferred until the stage reports a real size.

## 2026-10-08 (e) — "three separate lines": levels must converge or say why not

Teng on `L2_tensors`: *"the content of this page is just 3 separate lines."*
Right — three columns that never touched, so the page said nothing about how
the streams combine, which is the only interesting part of a forward pass.

- **L2_tensors now converges.** New bottom row **WHERE THEY MEET** holds the
  `for block in self.blocks: x = block(x, e=e0, context=context, …)` call, with
  the three columns feeding in under their actual roles: *the sequence —
  rewritten in place* / *read-only K/V for cross-attn* / *modulation — never a
  token*. The asymmetry (attention length is 32760, not 32760 + 512) is the
  takeaway and now has a note.
- **Band labels no longer render under the boxes.** A band sharing rows with
  nodes draws its label above itself instead of centred; all band text gained a
  halo. (The old `concat` band's label was running through the token boxes.)
- **Guard:** `check_connectivity()` — on a `kind:"flow"` level every lane must
  reach every other lane through some edge or band. It flagged `L5_attention`
  and `L6_subops`, which are legitimately parallel, so levels now declare
  `kind: flow | compare | gallery` and the page *says so*: a caption under the
  lane headers, plus, for a comparison, a **same / differs** chip per row in the
  gap between the columns — which turns the empty space into the actual lesson
  (QK-norm `same`, projections `differs`, position `differs`, output `same`).
- 125 refs OK; continuity, connectivity and render checks all clean.

## 2026-10-08 (d) — an arrow that started in empty space

Teng spotted the `one velocity` arrow into `sample_scheduler.step` leaving from
nothing.

- **Cause.** When an edge joins a band to a node, the renderer borrows the
  node's x so the arrow stays in its lane. That is right for a full-width band,
  but the CFG band spans only the two branch lanes while `scheduler.step` sits
  in the latent lane — so the start point landed ~110px to the LEFT of the band,
  in empty space. Anchors are now clamped to the band's own extent.
- **Guard:** [`webui/check_render.py`](webui/check_render.py) walks every level
  in a real browser and asserts each arrow's start and end actually touch the
  boxes it names, plus: overlay hidden, nodes present, overview code loaded, no
  sideways page scroll. Negative-tested — reverting the clamp yields
  `mix->step: START off the 'mix' box` and a non-zero exit.
- `check_render.py` is now the second half of verification, next to
  `build_viz.py --check --strict`. 65 edges over 7 levels, all anchored.

## 2026-10-08 (c) — a drill must not change the subject

Teng: *"the first page says `for t in timesteps … CFG … scheduler.step`, but
clicking it shows nothing about the loop, CFG or step at all."* Correct, and it
was a structural bug, not a cosmetic one.

- **Root cause.** `L1_pipeline.loop` promised three things — the loop, the CFG
  mix, the scheduler step — and drilled straight into `L2_tensors`, which is
  about patch/text/time embedding inside ONE forward pass. Two of the three
  things the box advertised were explained nowhere in the atlas.
- **Fix: the missing level.** New [`L1b_step`](specs/wan13b/L1b_step.json)
  — *Inside one denoising step* — is exactly what the box promised: the same x
  into two branches, `WanModel(x,t,context)` vs `WanModel(x,t,context_null)`,
  the CFG mix as a dark band, `sample_scheduler.step`, and a dashed loop-back
  arrow. Its overview code is `text2video.py:340-365` — the very lines the
  parent box cites. The WanModel box inside it is what now opens `L2_tensors`.
- The chain reads honestly end to end: Pipeline → **One step** → Tensors →
  Block stack → Block order → Attention → Sub-ops (7 levels).
- **Guard so it cannot recur silently:** `check_continuity()` in `build_viz.py`
  asserts that a drill target's overview `code` shares a source file with the
  box that opens it. Reverting the old wiring as a negative test produces
  `continuity: wan13b/L1_pipeline 'loop' cites ['wan.t2v'] but opens
  L2_tensors, which is about ['wan.model'] — the subject changes on click`
  and `--strict` exits 1. The audit also showed the other six drills were
  already consistent.
- 123 refs, all `OK`; continuity clean.

## 2026-10-08 (b) — levels are now connected, and every level has overview code

Two gaps Teng called out, both closed.

- **Overview code per level.** A level now carries its own `code: []`, shown in
  the panel whenever nothing is selected — so you land on a level and
  immediately read the whole function it draws (`WanAttentionBlock.forward` for
  the block level, `WanT2V.generate`'s loop for the pipeline, both attention
  `forward`s as two tabs for the attention level). The panel is never blank.
- **Visible connection between levels.** Each level declares
  `zoom_from: {level, node, label}` and renders a **zoom lens** at the top: a
  ghost of the parent box with a funnel opening down into this level, captioned
  "<parent level> · zoom in on <that box>", clickable to go back up. Going up
  lands on that exact node, selected, so its code is already open. Conversely
  every box that opens a level now says `opens → <level>` on its own line
  instead of showing a bare triangle.
- Round trip verified in the browser: L1 →drill→ L2 → L3 → L4, then the lens
  walks back L4 → `L3/blk` → `L2/t_lat` → `L1/loop`.
- Levels gained a `short` name, used by the rail and the `opens →` labels
  (full titles were truncating to nothing in narrow boxes).
- 103 refs, all `OK` under `--check --strict`.

Also fixed: the L3 attention band had silently lost its `drill` to L4 in an
earlier rewrite — the browser sweep caught it by counting `opens →` labels.

## 2026-10-08 — Wan 1.3B: all six levels, 90 code refs, every one verified

The full ladder is live on **:8877** — pipeline → tensors → stack → block order →
attention → sub-ops. Table of what each level answers: [`README.md`](README.md).

- **L4 is the one to read**: `WanAttentionBlock.forward` as 13 numbered rows in
  execution order, with the 6 AdaLN taps fanning in from their own lane and the
  three residual skips drawn on the left. Notes call out the asymmetry
  (self-attn and MLP are gated by e[2]/e[5]; cross-attention is an ungated add)
  and the float32 boundaries.
- **L5** puts self- and cross-attention in parallel columns: the only differences
  are K/V source, no RoPE, and which `k_lens` is passed.
- **Audit caught 22 wrong refs before they shipped.** Sealing every ref against
  its enclosing `ast` symbol exposed ranges that pointed at a blank line
  (`head` call site was 500, the call is at 499), at a continuation line
  (`norm3` was 211-213, it is 212-214), or at the wrong embedder
  (`time_embedding` was 388-392, which is the tail of `text_embedding`).
  All corrected; **90/90 refs now anchor to a relocatable symbol**, `--check
  --strict` clean.
- Builder gained **symbol snapping**: a range that starts at a symbol but
  overshoots its end is snapped to the symbol, so it stays relocatable.
- **Renderer: fit-to-width, not fit-to-page.** A 13-row diagram letterboxed with
  `preserveAspectRatio="meet"` shrank the text to nothing. The SVG is now sized
  to the stage width and `#stageScroll` scrolls; ctrl+wheel zooms. A
  `ResizeObserver` handles the fact that `draw()` runs while `#app` is still
  hidden and the scroller has width 0.

**Next:** MiniMax-H3, then gemma-4-31B, then the cross-model Mechanisms pages.

## 2026-10-07 18:09 +08 — scaffold + renderer + code binding, Wan `L3_stack` live

First vertical slice works end to end. Page on **:8877**
(`webui/serve.py 8877`, log `webui/atlas_8877.log`).

- **Spec format frozen enough to author against** — lanes × rows grid, `nodes` /
  `bands` / `edges` / `notes`, explicit placement, renderer does the pixel math.
  Schema + "how to add a model" in [`README.md`](README.md).
- **Code binding is live, not baked**: `GET /api/src?src=<key>&a=&b=` reads the
  file off disk through a generated allowlist of **keys** (403 on anything else,
  400 over 400 lines). Clicking the attention band shows
  `Wan2.2/wan/modules/model.py:189-265`.
- **Drift guard verified**: shifting a ref by +5 lines is reported `MOVED` and
  `--fix` repairs it to `[189, 265]`; `--check --strict` then passes (13/13 OK).
- **Dims come from the checkpoint**: `{{cfg.*}}` is expanded from
  `/pub/model_group/c84394362/wan_models/Wan2.1-T2V-1.3B/config.json`.
- Browser-verified in headless Chromium at 1500/1200/1024/900/720 px, dark+light,
  no page h-scroll, no JS errors. Four bugs that only a real browser showed:
  pointer-capture on `pointerdown` ate every click; full-height lane guides
  intercepted pointer events; emoji state glyphs rendered as tofu (now geometry);
  a spec's own `pad` clipped its row labels (left margin is now derived).

**Next:** style checkpoint with Teng, then author Wan `L1_pipeline` / `L2_tensors`
/ `L4_block` / `L5_subops`, then MiniMax-H3, then gemma-4-31B.
Qwen is deferred — it is one more `specs/<model>/` dir when wanted.

### Note: this bucket is outside git

`evaluation/ration_anomaly/dataset` is a symlink to
`/pub/data_group/zhangjunzhe/data/AB_test`, which is **not a git repo**. So
`specs/` (hand-authored source worth versioning) and `webui/` are untracked
here, the same as the siblings `rl_toy` / `bad_reward` / `LoRA_FFT`. If the
specs should be version-controlled, move `specs/` + `webui/` into the repo tree
and symlink them back.
