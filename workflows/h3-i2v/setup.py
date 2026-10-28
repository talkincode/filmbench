#!/usr/bin/env python3
"""一次性准备：ComfyUI + H3 模型 + 起服务。幂等（marker 命中则只确保服务在跑）。"""
import hashlib, json, os, subprocess, sys, time, traceback, urllib.request

REMOTE = os.environ.get("FILMBENCH_REMOTE", "/content/filmbench")
COMFY = "/content/ComfyUI"
MODELS = os.path.join(COMFY, "models")
FILES = [
    "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "vae/minimax_h3_video_vae_fp16.safetensors",
    "vae/minimax_h3_audio_vae_fp32.safetensors",
    "model_patches/minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors",
    "loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
]


def run(cmd, cwd=None):
    print("[setup]", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def comfy_up():
    try:
        urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=3)
        return True
    except Exception:
        return False


try:
    spec = json.load(open(os.path.join(REMOTE, "workflow.json")))
    persist = spec.get("persist") or os.path.join(REMOTE, "persist")
    os.makedirs(persist, exist_ok=True)
    key = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    marker = os.path.join(persist, f".setup-h3-{key}")

    if not os.path.exists(marker):
        if not os.path.isdir(COMFY):
            run(["git", "clone", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI.git", COMFY])
        run([sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"], cwd=COMFY)
        run([sys.executable, "-m", "pip", "install", "-q", "-U", "huggingface_hub[hf_xet]"])

        from huggingface_hub import hf_hub_download
        import concurrent.futures as cf

        def grab(rel):
            local = hf_hub_download("Comfy-Org/MiniMax-H3", rel, local_dir="/content/hf/MiniMax-H3")
            dst = os.path.join(MODELS, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if not os.path.exists(dst):
                os.symlink(local, dst)
            print("[setup] GOT", rel, flush=True)
            return rel

        with cf.ThreadPoolExecutor(4) as ex:
            for f in ex.map(grab, FILES):
                pass
        open(marker, "w").write(str(time.time()))
        print("[setup] models ready", marker, flush=True)
    else:
        print("[setup] cached", marker, flush=True)

    if not comfy_up():
        log = open("/content/comfy.log", "ab")
        subprocess.Popen(
            [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188"],
            cwd=COMFY, stdout=log, stderr=log, start_new_session=True,
        )
        for _ in range(120):
            time.sleep(3)
            if comfy_up():
                break
        else:
            raise SystemExit("ComfyUI 启动超时（看 /content/comfy.log）")
    print("[setup] comfy ready", flush=True)

    watchdog = os.path.join(REMOTE, "watchdog.py")
    if os.path.exists(watchdog):
        log = open(os.path.join(REMOTE, "watchdog.log"), "ab")
        subprocess.Popen([sys.executable, watchdog], stdout=log, stderr=log, start_new_session=True)
        print("[setup] watchdog started", flush=True)

    print("__FB_OK__")
except Exception:
    print("__FB_FAIL__ setup 失败")
    traceback.print_exc()
    sys.exit(1)
