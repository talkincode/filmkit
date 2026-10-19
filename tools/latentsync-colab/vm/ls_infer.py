"""latentsync-colab/v1 -- run inside /content/ls-venv with cwd=/content/LatentSync (pinned commit).

Same model setup as scripts/inference.py @ a229c39 (stage2_512.yaml, DDIM from configs/, whisper tiny, sd-vae-ft-mse
fp16 with scaling 0.18215, DeepCache interval 3 / branch 0, steps/guidance/seed from vm/pins.json), but the models
are loaded ONCE and every clip in config.json runs in this process. Differences from upstream, on purpose:
  * the VAE is loaded from the pinned, sha256-checked local copy instead of resolving stabilityai/sd-vae-ft-mse@main;
  * the seed is re-set before every clip, so each clip is reproducible on its own;
  * per-clip wall time and peak VRAM go to out/results.jsonl (one JSON line per event).
Usage: python ls_infer.py /content/ls
"""
import json
import os
import sys
import time
import traceback

import torch
from accelerate.utils import set_seed
from diffusers import AutoencoderKL, DDIMScheduler
from omegaconf import OmegaConf

from latentsync.models.unet import UNet3DConditionModel
from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
from latentsync.whisper.audio2feature import Audio2Feature

root = sys.argv[1]
cfg = json.load(open(os.path.join(root, "config.json")))
pins = json.load(open(os.path.join(root, "vm", "pins.json")))
inf = pins["inference"]
results = open(os.path.join(root, "out", "results.jsonl"), "a")


def emit(obj):
    results.write(json.dumps(obj) + "\n")
    results.flush()
    print("RESULT " + json.dumps(obj), flush=True)


t0 = time.time()
config = OmegaConf.load(pins["unetConfig"])
dtype = torch.float16 if torch.cuda.get_device_capability()[0] > 7 else torch.float32
scheduler = DDIMScheduler.from_pretrained("configs")
assert config.model.cross_attention_dim == 384, "stage2_512 uses whisper tiny"
audio_encoder = Audio2Feature(model_path="checkpoints/whisper/tiny.pt", device="cuda",
                              num_frames=config.data.num_frames, audio_feat_length=config.data.audio_feat_length)
vae = AutoencoderKL.from_pretrained("checkpoints/sd-vae-ft-mse", torch_dtype=dtype)
vae.config.scaling_factor = 0.18215
vae.config.shift_factor = 0
unet, _ = UNet3DConditionModel.from_pretrained(OmegaConf.to_container(config.model), "checkpoints/latentsync_unet.pt",
                                               device="cpu")
unet = unet.to(dtype=dtype)
pipeline = LipsyncPipeline(vae=vae, audio_encoder=audio_encoder, unet=unet, scheduler=scheduler).to("cuda")
if inf["enable_deepcache"]:
    from DeepCache import DeepCacheSDHelper
    helper = DeepCacheSDHelper(pipe=pipeline)
    helper.set_params(cache_interval=3, cache_branch_id=0)
    helper.enable()
emit({"event": "loaded", "loadSec": round(time.time() - t0, 1), "resolution": config.data.resolution,
      "dtype": str(dtype)})

failed = 0
for clip in cfg["clips"]:
    cid = clip["id"]
    out = os.path.join(root, "out", cid + ".raw.mp4")
    emit({"id": cid, "state": "running"})
    torch.cuda.reset_peak_memory_stats()
    t = time.time()
    try:
        set_seed(inf["seed"])
        pipeline(video_path=os.path.join(root, "inputs", clip["video"]),
                 audio_path=os.path.join(root, "inputs", clip["audio"]),
                 video_out_path=out, num_frames=config.data.num_frames,
                 num_inference_steps=inf["inference_steps"], guidance_scale=inf["guidance_scale"],
                 weight_dtype=dtype, width=config.data.resolution, height=config.data.resolution,
                 mask_image_path=config.data.mask_image_path, temp_dir="temp_" + cid)
        if not os.path.isfile(out) or os.path.getsize(out) == 0:
            raise RuntimeError("no output written (final ffmpeg mux failed?)")
        import hashlib
        h = hashlib.sha256(open(out, "rb").read()).hexdigest()
        emit({"id": cid, "state": "done", "wallSec": round(time.time() - t, 1),
              "peakVramMiB": torch.cuda.max_memory_allocated() // 2**20, "output": "out/%s.raw.mp4" % cid,
              "bytes": os.path.getsize(out), "sha256": h})
    except Exception as e:  # one failed clip does not stop the other (never retried)
        failed += 1
        traceback.print_exc()
        emit({"id": cid, "state": "failed", "wallSec": round(time.time() - t, 1),
              "peakVramMiB": torch.cuda.max_memory_allocated() // 2**20, "error": "%s: %s" % (type(e).__name__, e)})
    torch.cuda.empty_cache()
sys.exit(1 if failed else 0)
