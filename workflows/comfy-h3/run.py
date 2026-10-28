#!/usr/bin/env python3
"""
跑一个作业：起 ComfyUI（如果没在跑）→ 提交 API 工作流 → 等结果 → 落到 out 路径。
作业 spec 由 filmbench 生成：{"jobId", "workflow", "params", "refs", "out"}
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
spec_path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FILMBENCH_JOB")
if not spec_path:
    raise SystemExit("缺少作业 spec：argv[1] 或 FILMBENCH_JOB")
spec = json.load(open(spec_path))
comfy_dir = os.path.join(REMOTE, "ComfyUI")
comfy_workflow = os.path.join(REMOTE, spec.get("workflow") or "comfy/workflow.json")
out_path = spec.get("out") or os.path.join(REMOTE, "out", f"{spec['jobId']}.mp4")


def http(path, payload=None):
    url = "http://127.0.0.1:8188" + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def ensure_server():
    try:
        http("/history")
        print("[run] ComfyUI 已在运行")
        return
    except Exception:
        pass
    log = open(os.path.join(REMOTE, "comfy.log"), "ab")
    subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd=comfy_dir, stdout=log, stderr=log,
    )
    for _ in range(120):
        time.sleep(2)
        try:
            http("/history")
            print("[run] ComfyUI 就绪")
            return
        except Exception:
            continue
    raise SystemExit("ComfyUI 启动超时（看 comfy.log）")


def patch(graph, params):
    """把 params 写进图里：prompt 写正/负向文本，width/height 写空 latent，seed 写采样器。"""
    for node in graph.values():
        cls = node.get("class_type")
        if cls == "CLIPTextEncode" and params.get("prompt"):
            node.setdefault("inputs", {})["text"] = params["prompt"]
        if cls == "EmptyLatentImage":
            if params.get("width"):
                node["inputs"]["width"] = int(params["width"])
            if params.get("height"):
                node["inputs"]["height"] = int(params["height"])
            if params.get("frames"):
                node["inputs"]["batch_size"] = int(params["frames"])
        if cls in ("KSampler", "KSamplerAdvanced") and params.get("seed") is not None:
            node["inputs"]["seed"] = int(params["seed"])
    return graph


ensure_server()
graph = patch(json.load(open(comfy_workflow)), spec.get("params") or {})
queued = http("/prompt", {"prompt": graph})
prompt_id = queued.get("prompt_id")
if not prompt_id:
    raise SystemExit(f"提交失败: {queued}")

deadline = time.time() + int(spec.get("timeoutSec", 1200))
while time.time() < deadline:
    history = http(f"/history/{prompt_id}")
    entry = history.get(prompt_id)
    if entry:
        outputs = entry.get("outputs") or {}
        files = [
            (node_out.get("filename"), node_out.get("subfolder"))
            for node_out in outputs.values()
            for key in ("images", "gifs", "videos")
            for node_out in node_out.get(key, [])
        ]
        if not files:
            raise SystemExit(f"没有输出文件: {json.dumps(entry)[:400]}")
        name, sub = files[-1]
        src = os.path.join(comfy_dir, "output", sub or "", name)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        shutil.copyfile(src, out_path)
        print("[run] done", out_path, os.path.getsize(out_path))
        print("__FB_OK__")
        sys.exit(0)
    time.sleep(3)

raise SystemExit("等待超时")
