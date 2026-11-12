# sources/ — snapshots of the cited upstream files

Snapshot taken **2026-11-12** by `webui/snapshot_sources.py`, **for line-reference
display only**: `webui/serve.py` reads these when the build-host path in
`specs/sources.json` does not exist (`ATLAS_SOURCES=auto`, the default). None of
this code is imported or run by the atlas. Each file is byte-identical to its
original at snapshot time and keeps its original copyright/licence header.

Every file below is under the **Apache License 2.0**, checked against the
upstream `LICENSE` file or the installed package's `dist-info` metadata on the
build host.

| key | upstream project | version / commit | licence | original path (build host) |
|---|---|---|---|---|
| `wan.model` | [Wan2.2](https://github.com/Wan-Video/Wan2.2) | vendored in `temporal-caption-sg` @ `b239075a` (pyproject 2.2.0) | Apache-2.0 (`Wan2.2/LICENSE.txt`) | `.../temporal-caption-sg/Wan2.2/wan/modules/model.py` |
| `wan.attention` | Wan2.2 | same | Apache-2.0 | `.../Wan2.2/wan/modules/attention.py` |
| `wan.vae` | Wan2.2 | same | Apache-2.0 | `.../Wan2.2/wan/modules/vae2_1.py` |
| `wan.t5` | Wan2.2 | same | Apache-2.0 | `.../Wan2.2/wan/modules/t5.py` |
| `wan.t2v` | Wan2.2 | same | Apache-2.0 | `.../Wan2.2/wan/text2video.py` |
| `wan.pipeline` | [DiffSynth-Studio](https://github.com/modelscope/DiffSynth-Studio) | vendored in `temporal-caption-sg` @ `b239075a` (pyproject 2.0.11) | Apache-2.0 (`DiffSynth-Studio/LICENSE`) | `.../temporal-caption-sg/DiffSynth-Studio/diffsynth/pipelines/wan_video.py` |
| `mmx.dit` | [VideoX-Fun](https://github.com/aigc-apps/VideoX-Fun) | `968f0e2` **+ local uncommitted modification** (see below) | Apache-2.0 (`VideoX-Fun/LICENSE`) | `/pub/data_group/zhangjunzhe/code/VideoX-Fun/videox_fun/models/minimax_h3_transformer3d.py` |
| `mmx.vae` | VideoX-Fun | `968f0e2` (unmodified) | Apache-2.0 | `.../VideoX-Fun/videox_fun/models/minimax_h3_vae.py` |
| `mmx.pipe` | VideoX-Fun | `968f0e2` (unmodified) | Apache-2.0 | `.../VideoX-Fun/videox_fun/pipeline/pipeline_minimax_h3.py` |
| `mmx.sglang` | [SGLang](https://github.com/sgl-project/sglang) | `0.0.0.dev1+g45c00daa1.d20260803` (env `minimax_h3`) | Apache-2.0 (dist-info classifier + SPDX header) | `/root/miniconda3/envs/minimax_h3/lib/python3.12/site-packages/sglang/multimodal_gen/runtime/models/dits/minimax_h3.py` |
| `gemma4.hf` | [transformers](https://github.com/huggingface/transformers) | 5.5.4 (env `vllm`) | Apache-2.0 (dist-info `LICENSE`) | `/root/miniconda3/envs/vllm/lib/python3.11/site-packages/transformers/models/gemma4/modeling_gemma4.py` |
| `qwen35.hf` | transformers | 5.14.1 (env `lingbot-vomni`) | Apache-2.0 (dist-info `LICENSE`) | `/root/miniconda3/envs/lingbot-vomni/lib/python3.12/site-packages/transformers/models/qwen3_5/modeling_qwen3_5.py` |
| `gemma4.vllm` | [vLLM](https://github.com/vllm-project/vllm) | 0.19.1 (env `vllm`) | Apache-2.0 (dist-info `License-Expression`) | `/root/miniconda3/envs/vllm/lib/python3.11/site-packages/vllm/model_executor/models/gemma4.py` |
| `gemma4.vllm_mm` | vLLM | 0.19.1 | Apache-2.0 | `.../vllm/model_executor/models/gemma4_mm.py` |
| `qwen35.vllm` | vLLM | 0.19.1 | Apache-2.0 | `.../vllm/model_executor/models/qwen3_5.py` |
| `qwen35.gdn` | vLLM | 0.19.1 | Apache-2.0 | `.../vllm/model_executor/layers/mamba/gdn_linear_attn.py` |

`wan.pipeline` and `gemma4.vllm_mm` are listed in `specs/sources.json` but no
diagram currently cites them (they are not in `webui/data/allowlist.json`).

**`mmx.dit` differs from upstream `968f0e2`.** The build host's VideoX-Fun
checkout carries an uncommitted 6+/3- change in
`MiniMaxH3Transformer3DModel.from_pretrained_original` (accepts
`**config_overrides`, passes `allow_missing_prefixes=("control_",)`), so from
about line 564 on this snapshot is 3 lines ahead of the upstream file. The
atlas line refs were sealed against this modified file, so this snapshot is the
one that matches them.

## Refresh

On the build host, after `webui/build_viz.py`:

```bash
/root/miniconda3/envs/ltx2/bin/python webui/snapshot_sources.py
```

Then update the version/commit column above if an upstream changed.
