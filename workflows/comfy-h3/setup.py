#!/usr/bin/env python3
"""
一次性环境准备：pip 依赖、ComfyUI、模型、idle watchdog。
幂等：workflow.json 的哈希写进 persist 目录的 marker，命中就直接返回。
persist 目录建议挂 Google Drive（`colab drivemount /content/drive`），这样 VM 被回收也不用重下。
"""
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
except Exception:
    print("__FB_FAIL__ setup 读取 workflow.json 失败")
    traceback.print_exc()
    sys.exit(1)
persist = spec.get("persist") or os.path.join(REMOTE, "persist")
os.makedirs(persist, exist_ok=True)

key = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
marker = os.path.join(persist, f".setup-{key}")
if os.path.exists(marker):
    print(f"[setup] cached ({marker}) — 跳过安装")
    print("__FB_OK__")
    sys.exit(0)


def run(cmd, **kw):
    print("[setup]", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kw)


print("[setup] python", sys.version.split()[0])
pips = spec.get("pips", [])
if pips:
    run([sys.executable, "-m", "pip", "install", "-q", *pips])
else:
    print("[setup] 没有额外 pip 依赖，跳过")

for repo in spec.get("repos", []):
    path = os.path.join(REMOTE, repo["dir"])
    if not os.path.isdir(os.path.join(path, ".git")):
        run(["git", "clone", "--depth", "1", "--branch", repo.get("ref", "master"), repo["url"], path])
    else:
        print("[setup] repo exists:", path)

for model in spec.get("models", []):
    dest = os.path.join(persist, model["file"])
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print("[setup] model cached:", dest)
        continue
    if "example.invalid" in model.get("url", ""):
        print("[setup] 跳过占位模型（把 workflow.json 里的 url 换成真实地址）")
        continue
    print("[setup] download", model["url"])
    subprocess.run(["curl", "-fL", "--retry", "3", "-o", dest + ".part", model["url"]], check=True)
    os.replace(dest + ".part", dest)

# 软链模型进 ComfyUI，避免复制
comfy = os.path.join(REMOTE, "ComfyUI", "models")
for root, _dirs, files in os.walk(os.path.join(persist, "models")):
    rel = os.path.relpath(root, os.path.join(persist, "models"))
    target = os.path.join(comfy, rel) if rel != "." else comfy
    os.makedirs(target, exist_ok=True)
    for f in files:
        src = os.path.join(root, f)
        dst = os.path.join(target, f)
        if not os.path.exists(dst):
            os.symlink(src, dst)

# colab exec 是在 kernel 里 exec 代码，没有 __file__；用解包目录
watchdog = os.path.join(REMOTE, "watchdog.py")
if os.path.exists(watchdog):
    log = open(os.path.join(REMOTE, "watchdog.log"), "ab")
    subprocess.Popen([sys.executable, watchdog], stdout=log, stderr=log, start_new_session=True)
    print("[setup] watchdog started")

open(marker, "w").write(str(time.time()))
print("[setup] done", marker)
print("__FB_OK__")
