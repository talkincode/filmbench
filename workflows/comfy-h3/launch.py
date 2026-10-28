#!/usr/bin/env python3
"""在 VM 上后台起一个长任务，立刻返回（colab exec 的长单元格会掉连接）。"""
import json
import os
import subprocess

task = os.environ["FB_TASK"]
args = json.loads(os.environ.get("FB_ARGS") or "[]")
log = os.environ.get("FB_LOG", "/content/filmbench/task.log")
status = os.environ.get("FB_STATUS", "/content/filmbench/task.status")
os.makedirs(os.path.dirname(log), exist_ok=True)
try:
    os.remove(status)
except FileNotFoundError:
    pass

cmd = " ".join(["python3", task, *args])
script = f"{cmd} > {log} 2>&1; echo $? > {status}"
subprocess.Popen(["sh", "-c", script], start_new_session=True)
print("[launch]", script)
print("__FB_OK__")
