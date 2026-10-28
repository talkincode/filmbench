#!/usr/bin/env python3
"""MiniMax H3 首/尾帧图生视频。默认值全部来自 workflow.json，脚本不写死画幅与步数。"""
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
GRID = 17
GRID_OFFSET = 5
TRAINED_MIN, TRAINED_MAX = 124, 362


def api(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def snap_length(requested: int) -> int:
    """节点会把 length 吸附到 17k+5；同时限制在训练区间内。"""
    k = max(1, math.ceil((requested - GRID_OFFSET) / GRID))
    frames = GRID * k + GRID_OFFSET
    if frames < TRAINED_MIN:
        frames = TRAINED_MIN
    if frames > TRAINED_MAX:
        print(f"[run] length {requested} 超出训练区间，截到 {TRAINED_MAX}", flush=True)
        frames = TRAINED_MAX
    return frames


def stage_image(remote_path: str, name: str) -> str:
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
    defaults = wf.get("defaults") or {}
    for key in ("width", "height", "length", "steps", "seed", "fps"):
        if key not in defaults:
            raise SystemExit(f"workflow.json 缺少 defaults.{key}（脚本不再给默认值）")

    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.environ["FILMBENCH_JOB"]
    job = json.load(open(spec_path))
    params = job.get("params") or {}
    prompt = (params.get("prompt") or "").strip()
    if not prompt:
        raise SystemExit("缺少 prompt")

    refs = job.get("refs") or []
    roles = job.get("refRoles") or []
    def pick(role):
        for i, r in enumerate(roles):
            if r == role and i < len(refs):
                return refs[i]
        return None

    first = pick("first_frame")
    if not first:
        raise SystemExit("缺少首帧参考（role: first_frame）")
    last = pick("last_frame")

    draft = params.get("draft") in (True, "true", "1", 1)
    steps = int(params.get("steps") or (8 if draft else defaults["steps"]))
    seed = int(params.get("seed") if params.get("seed") is not None else defaults["seed"])
    width = int(params.get("width") or defaults["width"])
    height = int(params.get("height") or defaults["height"])
    length = snap_length(int(params.get("length") or defaults["length"]))
    fps = float(params.get("fps") or defaults["fps"])
    out = job.get("out") or os.path.join(REMOTE, "out", f"{job['jobId']}.mp4")

    graph = json.load(open(os.path.join(REMOTE, "graph.json")))
    if not draft:
        graph.pop("2", None)
        for node in graph.values():
            for k, v in list(node.get("inputs", {}).items()):
                if isinstance(v, list) and len(v) == 2 and v[0] == "2":
                    node["inputs"][k] = ["1", v[1]]

    graph["20"]["inputs"]["image"] = stage_image(first, f"{job['jobId']}-first.png")
    inputs = graph["6"]["inputs"]
    inputs.update({"prompt": prompt, "width": width, "height": height, "length": length, "first_frame": ["20", 0]})
    if last:
        graph["21"]["inputs"]["image"] = stage_image(last, f"{job['jobId']}-last.png")
        inputs["last_frame"] = ["21", 0]
        print("[run] 使用尾帧衔接", flush=True)
    else:
        graph.pop("21", None)
        inputs.pop("last_frame", None)

    graph["8"]["inputs"]["steps"] = steps
    graph["9"]["inputs"]["noise_seed"] = seed
    graph["15"]["inputs"]["filename_prefix"] = f"fb/{job['jobId']}"

    t0 = time.time()
    pid = api("/prompt", {"prompt": graph})["prompt_id"]
    print(
        f"[run] submit {job['jobId']} draft={draft} steps={steps} seed={seed} "
        f"{width}x{height}x{length} last_frame={bool(last)}",
        flush=True,
    )

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
        outs = h[pid]["outputs"].get("15", {})
        files = outs.get("images", []) + outs.get("videos", [])
        if not files:
            raise SystemExit(f"没有输出视频: {json.dumps(outs)[:300]}")
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
