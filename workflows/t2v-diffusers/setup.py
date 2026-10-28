#!/usr/bin/env python3
"""一次性准备：装 diffusers 依赖 + 预热模型缓存。幂等（marker 命中即跳过）。"""
import hashlib
import json
import os
import subprocess
import sys
import time
import traceback

try:
    REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
    spec = json.load(open(os.path.join(REMOTE, "workflow.json")))
    persist = spec.get("persist") or os.path.join(REMOTE, "persist")
    os.makedirs(persist, exist_ok=True)

    key = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    marker = os.path.join(persist, f".setup-{key}")

    def run(cmd):
        print("[setup]", " ".join(cmd), flush=True)
        subprocess.run(cmd, check=True)

    if os.path.exists(marker):
        print("[setup] cached", marker)
        print("__FB_OK__")
        sys.exit(0)

    print("[setup] torch", __import__("torch").__version__, "cuda", __import__("torch").cuda.is_available())
    pips = spec.get("pips", [])
    if pips:
        run([sys.executable, "-m", "pip", "install", "-q", *pips])

    # 预热模型（下载到 HF 缓存；同会话后续 run 秒开）
    run([
        sys.executable,
        "-c",
        "from diffusers import DiffusionPipeline; import torch; "
        "DiffusionPipeline.from_pretrained('damo-vilab/text-to-video-ms-1.7b', torch_dtype=torch.float16, variant='fp16'); "
        "print('model cached')",
    ])

    open(marker, "w").write(str(time.time()))
    print("[setup] done", marker)
    print("__FB_OK__")
except Exception:
    print("__FB_FAIL__ setup 失败")
    traceback.print_exc()
    sys.exit(1)
