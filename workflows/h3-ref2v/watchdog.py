#!/usr/bin/env python3
"""
VM 内看门狗：heartbeat 超过 idle 分钟没更新就 unassign，避免人走了 VM 一直烧 CU。
由 setup.py 以 nohup 方式拉起，进程不依赖本地 filmbench 是否还开着。
"""
import os
import sys
import time

HB = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench") + "/heartbeat"
IDLE = int(os.environ.get("FILMBENCH_IDLE_MINUTES", "30")) * 60

while True:
    time.sleep(60)
    try:
        age = time.time() - os.path.getmtime(HB)
    except FileNotFoundError:
        continue
    if age > IDLE:
        print(f"[watchdog] idle {age/60:.0f} min > {IDLE/60:.0f} min, unassign", flush=True)
        try:
            from google.colab import runtime
            runtime.unassign()
        except Exception as exc:
            print("[watchdog] unassign failed:", exc, flush=True)
        sys.exit(0)
