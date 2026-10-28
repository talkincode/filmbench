#!/usr/bin/env python3
"""解包上传的工作流目录，并创建一个初始 heartbeat。"""
import os
import tarfile
import time

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
os.makedirs(REMOTE, exist_ok=True)
pkg = "/content/fb-pkg.tar.gz"
if not os.path.exists(pkg):
    pkg = os.path.join(REMOTE, "pkg.tar.gz")
with tarfile.open(pkg) as tar:
    tar.extractall(REMOTE)
open(os.path.join(REMOTE, "heartbeat"), "w").write(str(time.time()))
print("[bootstrap] unpacked to", REMOTE)
print("__FB_OK__")
