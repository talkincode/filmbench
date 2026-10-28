#!/usr/bin/env python3
"""按 job spec 跑一条 H3 图生视频：上传首帧 → 提交 ComfyUI → 等完成 → 拷出 mp4。"""
import json
import os
import shutil
import sys
import time
import traceback
import urllib.request

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
COMFY = "/content/ComfyUI"
URL = "http://127.0.0.1:8188"


def api(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def main():
    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.environ["FILMBENCH_JOB"]
    spec = json.load(open(spec_path))
    params = spec.get("params") or {}
    prompt = (params.get("prompt") or "").strip()
    if not prompt:
        raise SystemExit("缺少 prompt")
    first = (spec.get("refs") or [None])[0]
    if not first:
        raise SystemExit("缺少首帧参考图（role: first_frame）")

    draft = params.get("draft") in (True, "true", "1", 1)
    steps = int(params.get("steps") or (8 if draft else 24))
    seed = int(params.get("seed") or 7101)
    width = int(params.get("width") or 1344)
    height = int(params.get("height") or 768)
    length = int(params.get("length") or 107)
    fps = float(params.get("fps") or 24)
    out = spec.get("out") or os.path.join(REMOTE, "out", f"{spec['jobId']}.mp4")

    # 首帧放进 ComfyUI 的 input 目录
    src = first
    if not os.path.isabs(src):
        src = os.path.join(REMOTE, src)
    name = f"{spec['jobId']}.png"
    os.makedirs(os.path.join(COMFY, "input"), exist_ok=True)
    dst = os.path.join(COMFY, "input", name)
    if src.lower().endswith(".png"):
        shutil.copyfile(src, dst)
    else:
        import subprocess
        subprocess.run(["ffmpeg", "-y", "-i", src, dst], check=True, capture_output=True)

    graph = json.load(open(os.path.join(REMOTE, "graph.json")))
    if not draft:
        # 正式档：去掉 turbo LoRA，引用改回底层模型
        graph.pop("2", None)
        for node in graph.values():
            for k, v in list(node.get("inputs", {}).items()):
                if isinstance(v, list) and len(v) == 2 and v[0] == "2":
                    node["inputs"][k] = ["1", v[1]]
    graph["6"]["inputs"].update(
        {"prompt": prompt, "width": width, "height": height, "length": length, "first_frame": ["20", 0]}
    )
    graph["8"]["inputs"]["steps"] = steps
    graph["9"]["inputs"]["noise_seed"] = seed
    graph["15"]["inputs"]["filename_prefix"] = f"fb/{spec['jobId']}"
    graph["20"]["inputs"]["image"] = name

    t0 = time.time()
    pid = api("/prompt", {"prompt": graph})["prompt_id"]
    print(f"[run] submit {spec['jobId']} draft={draft} steps={steps} seed={seed} {width}x{height}x{length}", flush=True)

    deadline = time.time() + int(params.get("timeoutSec") or 1800)
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
        src_out = os.path.join(COMFY, "output", f.get("subfolder", ""), f["filename"])
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copyfile(src_out, out)
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
