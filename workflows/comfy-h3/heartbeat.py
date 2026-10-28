#!/usr/bin/env python3
"""活动心跳：每次作业跑完 touch 一次，本地 reap 与 VM watchdog 都看它。"""
import os
import time

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
with open(os.path.join(REMOTE, "heartbeat"), "w") as f:
    f.write(str(time.time()))
print("[heartbeat]", time.strftime("%H:%M:%S"))
