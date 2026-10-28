#!/usr/bin/env python3
"""报告后台任务状态：RUNNING / DONE <code>，并附日志尾部。"""
import os

log = os.environ.get("FB_LOG", "/content/filmbench/task.log")
status = os.environ.get("FB_STATUS", "/content/filmbench/task.status")
if os.path.exists(log):
    lines = open(log, errors="replace").read().strip().split("\n")
    print("\n".join(lines[-30:]))
if os.path.exists(status):
    print("DONE", open(status).read().strip())
else:
    print("RUNNING")
print("__FB_OK__")
