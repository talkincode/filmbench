#!/usr/bin/env python3
"""按 job spec 生成一段短视频：ModelScope T2V 1.7B → 帧序列 → ffmpeg 循环/缩放/补边到成片规格。"""
import json
import os
import shutil
import subprocess
import sys
import traceback

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
MODEL = "damo-vilab/text-to-video-ms-1.7b"


def main():
    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FILMBENCH_JOB")
    spec = json.load(open(spec_path))
    params = spec.get("params") or {}
    prompt = params.get("prompt") or ""
    if not prompt.strip():
        raise SystemExit("缺少 prompt")
    width = int(params.get("width") or 1344)
    height = int(params.get("height") or 768)
    seconds = float(params.get("seconds") or 2)
    frames = int(params.get("numFrames") or 16)
    steps = int(params.get("steps") or 25)
    out = spec.get("out") or os.path.join(REMOTE, "out", f"{spec['jobId']}.mp4")

    import torch
    from diffusers import DiffusionPipeline

    print(f"[run] {MODEL} · {frames} frames · {steps} steps · {width}x{height} · {seconds}s", flush=True)
    pipe = DiffusionPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, variant="fp16")
    pipe.to("cuda")
    result = pipe(prompt, num_inference_steps=steps, num_frames=frames)
    video_frames = result.frames[0]

    seq_dir = os.path.join(REMOTE, "frames", spec["jobId"])
    shutil.rmtree(seq_dir, ignore_errors=True)
    os.makedirs(seq_dir, exist_ok=True)
    import numpy as np
    from PIL import Image

    for i, frame in enumerate(video_frames):
        arr = np.asarray(frame)
        if arr.dtype != np.uint8:
            # diffusers 有时返回 0..1 的 float32
            arr = (np.clip(arr, 0, 1) * 255).astype("uint8") if arr.max() <= 1.0 else arr.astype("uint8")
        Image.fromarray(arr).save(os.path.join(seq_dir, f"{i:03d}.png"))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
    )
    cmd = [
        "ffmpeg", "-y", "-stream_loop", "-1", "-framerate", "8",
        "-i", os.path.join(seq_dir, "%03d.png"),
        "-vf", vf, "-t", f"{seconds:.3f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", out,
    ]
    print("[run]", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    print("[run] done", out, os.path.getsize(out))
    print("__FB_OK__")


try:
    main()
except Exception:
    print("__FB_FAIL__ run 失败")
    traceback.print_exc()
    sys.exit(1)
