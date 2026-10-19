# latentsync-colab (test runner, not a filmkit task)

Post-process lip sync with **ByteDance LatentSync 1.6** over already-rendered clips, on one Colab VM.
Standalone on purpose: LatentSync needs Python 3.10 / torch 2.5.1 / diffusers 0.32 / insightface, which would
fight colab-comfy's pinned ComfyUI stack (Python 3.13, torch 2.11). If the test is good, a filmkit task can
wrap these same files later.

| file | runs on | what it does |
|---|---|---|
| `prep_inputs.sh` | box | old clip 24→25 fps (frame duplication, same duration), N = round(dur×25) frames; drive wav trimmed/padded to exactly N/25 s (24 kHz kept); writes `inputs/manifest.json` with sha256 |
| `preflight_faces.py` | box (CPU) | LatentSync's own face rules (insightface buffalo_l, det 512, w≥50, h≥80, score≥0.5) on **every** frame: one miss aborts a clip on the VM |
| `run.sh` | box | the only thing that talks to Colab: preflight (no session, 0 assignments) → `new` → mkdirs → upload → kick → poll → download → stop → verify → local finalize |
| `vm/ls_runner.py` | VM | pinned install + sha256-checked weights + inference + status.json + watchdog |
| `vm/ls_infer.py` | VM venv | upstream `scripts/inference.py` setup, models loaded once, all clips in one process |
| `vm/ls_{mkdirs,kick,poll,abort}.py` | VM kernel cells | short `colab exec` cells; success only from the `FKSTATUS {json}` line |
| `vm/pins.json`, `vm/requirements.lock.txt` | VM | every pin: LatentSync commit, HF revisions + sha256, buffalo_l sha256, uv/python, hash-locked wheels |
| `compare.sh` | box | OLD vs NEW side by side, labels burned in, new drive audio on both |
| `test/run_test.sh`, `test/runner_test.sh` | box | offline lifecycle tests (fake `colab`), runner status/watchdog tests (no GPU) |

## Colab rules carried over from colab-comfy
Every `colab` call under a host `timeout`; `exec` success only from `FKSTATUS` (rc is always 0); `restart-kernel`
after an exec timeout; no secrets and never `--env` (all weights are public); refuses to start if any session or
assignment exists; never H100, never `--high-mem`; stop is retried 3× and only `colab sessions` not listing the
session plus `colab usage` showing 0 assignments counts as released (exit 3 and a loud line otherwise). The VM
runner self-releases at the hard deadline (host deadline + 5 min) or when the host heartbeat is 15 min old.

## Use
```bash
cd tools/latentsync-colab
bash prep_inputs.sh                                   # -> /workspace/tmp/latentsync/inputs
bash run.sh --gpu L4 --budget-cu 1.0 --dry-run        # builds the bundle, no Colab
bash run.sh --gpu L4 --budget-cu 1.0 --out /workspace/tmp/latentsync/runs/ep004-L4
bash compare.sh --run /workspace/tmp/latentsync/runs/ep004-L4
bash test/run_test.sh && bash test/runner_test.sh
```
Outputs: `<id>.raw.mp4` (LatentSync as written, 16 kHz AAC), `<id>.ls.mp4` (trimmed to N frames, 24 kHz drive
audio muxed back, 25 fps), `run.json` (CU before/after, phases, per-clip wall/peak VRAM), `vm/*.log`.

## Inference settings (upstream defaults)
`configs/unet/stage2_512.yaml` (1.6, 512×512 face crop), 20 DDIM steps, guidance 1.5, DeepCache (interval 3),
seed 1247, fp16. Source: `inference.sh` @ a229c39.

## Licenses (read before publishing anything made with this)
* LatentSync code: Apache-2.0. Weights `ByteDance/LatentSync-1.6`: HF card says `openrail++` (no license file in the
  repo): commercial use allowed with use-based restrictions.
* `stabilityai/sd-vae-ft-mse`: MIT. Whisper tiny: MIT.
* **insightface buffalo_l (the face detector LatentSync inference requires): "non-commercial research purposes
  only".** Fine for this test; for a published/monetised episode either license it or swap the detector.
