#!/usr/bin/env python3
"""在 VM 上建目录（colab upload 不会自动建父目录，缺目录会 500）。"""
import json
import os
import sys

try:
    for d in json.loads(os.environ.get("FB_DIRS") or "[]"):
        os.makedirs(d, exist_ok=True)
        print("[mkdir]", d)
    print("__FB_OK__")
except Exception as exc:  # noqa: BLE001
    print("__FB_FAIL__", exc)
    sys.exit(1)
