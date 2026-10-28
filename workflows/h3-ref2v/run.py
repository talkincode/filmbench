#!/usr/bin/env python3
"""MiniMax H3 ref2va：参考图 + prompt → 视频（prompt 用 <Picture i> 指代第 i 张参考图）。"""
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback
import urllib.request

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
COMFY = "/content/ComfyUI"
URL = "http://127.0.0.1:8188"
GRID, OFFSET = 17, 5
TRAINED_MIN, TRAINED_MAX = 124, 362
MAX_REFS = 9


def api(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def snap_length(requested: int) -> int:
    k = max(1, math.ceil((requested - OFFSET) / GRID))
    return max(TRAINED_MIN, min(TRAINED_MAX, GRID * k + OFFSET))


def stage(remote_path: str, name: str) -> str:
    src = remote_path if os.path.isabs(remote_path) else os.path.join(REMOTE, remote_path)
    dst = os.path.join(COMFY, "input", name)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if src.lower().endswith(".png"):
        shutil.copyfile(src, dst)
    else:
        subprocess.run(["ffmpeg", "-y", "-i", src, dst], check=True, capture_output=True)
    return name


def main():
    wf = json.load(open(os.path.join(REMOTE, "workflow.json")))
    d = wf["defaults"]
    job = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.environ["FILMBENCH_JOB"]))
    params = job.get("params") or {}
    prompt = (params.get("prompt") or "").strip()
    if not prompt:
        raise SystemExit("缺少 prompt")
    refs = job.get("refs") or []
    if not refs:
        raise SystemExit("ref2v 需要至少一张参考图（intent.references）")
    if len(refs) > MAX_REFS:
        raise SystemExit(f"参考图最多 {MAX_REFS} 张，收到 {len(refs)}")

    graph = json.load(open(os.path.join(REMOTE, "graph.json")))
    ref_map = {}
    for i, path in enumerate(refs):
        name = stage(path, f"{job['jobId']}-ref{i}.png")
        node = str(20 + i)
        if node not in graph:
            graph[node] = {"class_type": "LoadImage", "inputs": {"image": name}}
        else:
            graph[node]["inputs"]["image"] = name
        ref_map[f"ref_image_{i}"] = [node, 0]

    width = int(params.get("width") or d["width"])
    height = int(params.get("height") or d["height"])
    length = snap_length(int(params.get("length") or d["length"]))
    steps = int(params.get("steps") or d["steps"])
    seed = int(params.get("seed") if params.get("seed") is not None else d["seed"])
    fps = float(params.get("fps") or d["fps"])

    graph["6"]["inputs"].update(
        {
            "prompt": prompt,
            "width": width,
            "height": height,
            "length": length,
            "ref_image_size": str(params.get("refImageSize") or d.get("refImageSize") or "match"),
            "ref_images": ref_map,
        }
    )
    graph["8"]["inputs"]["steps"] = steps
    graph["9"]["inputs"]["noise_seed"] = seed
    graph["14"]["inputs"]["fps"] = fps
    graph["15"]["inputs"]["filename_prefix"] = f"fb/{job['jobId']}"
    out = job.get("out") or os.path.join(REMOTE, "out", f"{job['jobId']}.mp4")

    t0 = time.time()
    pid = api("/prompt", {"prompt": graph})["prompt_id"]
    print(f"[run] submit {job['jobId']} refs={len(refs)} steps={steps} seed={seed} {width}x{height}x{length}", flush=True)

    deadline = time.time() + int(params.get("timeoutSec") or 2400)
    while time.time() < deadline:
        time.sleep(5)
        h = api(f"/history/{pid}")
        if pid not in h:
            continue
        status = h[pid].get("status", {})
        if status.get("status_str") != "success":
            for m in status.get("messages", []):
                if m[0] == "execution_error":
                    print("FAIL", m[1].get("node_type"), str(m[1].get("exception_message"))[:500], flush=True)
            raise SystemExit("ComfyUI 执行失败")
        files = h[pid]["outputs"].get("15", {}).get("images", []) + h[pid]["outputs"].get("15", {}).get("videos", [])
        if not files:
            raise SystemExit("没有输出视频")
        f = files[-1]
        src = os.path.join(COMFY, "output", f.get("subfolder", ""), f["filename"])
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copyfile(src, out)
        print(f"[run] done {time.time()-t0:.1f}s {out} {os.path.getsize(out)}", flush=True)
        print("__FB_OK__")
        return
    raise SystemExit("等待超时")


try:
    main()
except Exception:
    print("__FB_FAIL__ run 失败")
    traceback.print_exc()
    sys.exit(1)
