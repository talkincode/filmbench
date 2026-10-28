# comfy-h3 · 可复用 Colab 工作流

目标：**环境只装一次、模型只下一次**，之后每个作业只传 spec、跑图、取结果；30 分钟没人用自动关会话。

## 组成

| 文件 | 作用 |
| --- | --- |
| `workflow.json` | 环境声明：GPU、pip 依赖、ComfyUI 版本、模型清单、持久化目录、idle 分钟数 |
| `setup.py` | 幂等安装。`workflow.json` 的哈希作为 marker，命中就跳过；模型已存在就不重下 |
| `run.py` | 起 ComfyUI（没在跑才起）→ 提交 API 图 → 轮询 → 拷到 out 路径 |
| `comfy/workflow.json` | ComfyUI API 格式的图，`run.py` 会把 prompt / 尺寸 / seed 打进去 |
| `watchdog.py` | VM 内看门狗：heartbeat 超过 30 分钟 → `runtime.unassign()` |

## 持久化

`workflow.json` 里的 `persist` 指向 Google Drive（`colab drivemount /content/drive`）。模型、ComfyUI、marker 都放那儿：
VM 被回收后重新开会话，`setup.py` 命中 marker 直接跳过安装。

## 换成你自己的模型

1. 改 `workflow.json` 的 `models[].url`（或手工把权重放进 `persist/models/...`，setup 会跳过）
2. 改 `comfy/workflow.json` 的节点与 `ckpt_name`
3. 改完 `workflow.json` 哈希变化 → 下次自动重装一次

## 生命周期

```
filmbench colab up --workflow comfy-h3     # 建会话 + 上传 + setup（只装一次）
filmbench jobs run                          # provider 复用该会话；每次跑完 touch heartbeat
filmbench colab status                      # 会话、空闲分钟数、CU
filmbench colab reap                        # 手动清：空闲 > 30 分钟就 stop
filmbench colab down                        # 立即停
```

本地 engine 每 60 秒也会 reap 一次；即使 filmbench 关了，VM 里的 watchdog 也会在 30 分钟后自己 unassign。
