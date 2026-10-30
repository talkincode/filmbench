---
name: filmbench
description: >
  Orchestrate and compile a video with filmbench, a local workbench whose single
  source of truth is an append-only event journal: shots, providers, jobs,
  selection, review, compile IR, and a one-key acceptance check. Use when the
  user wants to plan, generate, assemble, review or render a video from shots
  (images, generated clips, recorded footage, title cards, narration, music),
  when a project already contains `.filmbench/`, or when the user mentions
  filmbench, 分镜, 九宫格审片, controlnet 灰模, or "compile a film from providers".
  Also use it to audit an existing film project (why a shot is stale, what is
  blocking the build) or to run its desktop UI, MCP server and built-in agent.
---

# filmbench

**真相是 append-only 的事件日志**；yaml / sqlite / 故事板 / lock 都是投影，删库可以 `reindex` 重建。
所有写入走同一个 `Service`（界面 / CLI / MCP / agent 同一套），`operationId` 幂等、`baseRevision` CAS。
时间基只有**整数帧**，秒只出现在展示与 ffmpeg argv 边界。

```
shots ─► 作业(provider) ─► 产物(内容寻址) ─► 选片 ─► 审阅 ─► 编译 IR ─► ffmpeg ─► final.mp4
                                                    └─ filmbench check（12 项）
```

## 每次开工先做三件事

```bash
filmbench doctor                  # ffmpeg / ffprobe / electron / pi / colab / imagine
filmbench status                  # 项目格式、镜头数、就绪情况、花费、哈希链
filmbench check                   # 能不能出片，卡在哪一条
```

不在项目里（找不到 `journal/`）时先 `filmbench init <dir> --name … --width … --height … --fps 24`。

## 常用流程

```bash
# 建镜头：意图 + 绑定 + 参考（角色槽位：identity / wardrobe / prop / environment / first_frame / last_frame / style）
filmbench shot add --id h1 --title 峡口工地 --frames 141 --provider colab --task video \
  --video-prompt "…" --param workflow=h3-i2v --param width=1344 --param height=768
filmbench ref add --shot h1 --asset asset-xxxx --role first_frame

# 跑作业（真花钱的一步，先报告预算）
filmbench jobs submit --all && filmbench jobs run

# 选片是独立的一步：产物 ≠ 已选
filmbench select --shot h1 && filmbench review --shot h1

# 审片：九宫格（按镜头时长等分 9 段）+ 机器规则；看懂图后把语义问题记进账本
filmbench review-shot --shot h1 --record --finding "凿子直插石头" --severity error
# 重拍后对比：上=上一版 / 下=当前，各取首中尾三帧
filmbench review-shot --shot h1 --compare

# 出片与验收
filmbench build && filmbench check
```

## 升级顺序（画面不达标时，按这个走，不要跳级）

1. **改静帧** —— 人物长相、服装、场景构成不对
2. **改提示词** —— 动作方向、镜头运动、环境运动写不清
3. **上 ControlNet 灰模** —— 构图与物体空间关系要被外部钉死
4. **换构图** —— 关系复杂到一帧说不清
5. **换素材** —— 这镜不该由模型做

一句话判断：**"东西长什么样"→改静帧；"东西在哪、往哪动"→上 controlnet。**

## 提示词四条硬规则（`filmbench prompt lint` 会检查）

| 规则 | lint id | 怎么写 |
| --- | --- | --- |
| 画面里不许有字 | `signage-leak` | 「画面中不要出现任何文字：没有匾额、旗号、木牌、刻字；旗幡与木牌都是空白素面」 |
| 背景必须自己动 | `static-background` | 水纹连续流动、白浪推进、雾在卷、云在移、火星上飘 |
| 动作要写接触关系 | `physics` | 「凿子以 45–60° 抵在石面浅槽里，凿尖嵌在槽口不刺入；木槌与左手留出空隙」 |
| 有人就要写人的动作 | `static-subject` | 挑担、弯腰搬石、走进门洞、回头——只写火把和雾，人会定格 |
| 分三层写 | `layering` | 前景（虚焦背影/晃动绳）→ 中景（主体动作）→ 远景（河谷山脊） |

静帧先出、再让它动；视频提示词不再描述长相。动作幅度写小（写"推近"模型会重构图像，单镜内部像跳切）。

## ControlNet（h3-i2v）

```bash
filmbench shot control --id h4 --video control/h4-control.mp4 --strength 1 --end 0.6
filmbench shot control --id h4 --clear
```

灰模写法：亮度当深度（255 贴脸 / 20 远景），按画家顺序 alpha 覆盖；只描述"在哪、往哪动"，不写材质与光；
长度与镜头帧数一致；`end 0.6` 表示后半段放开让模型补细节。

## 出错时

| 症状 | 处理 |
| --- | --- |
| 产物「过期」 | 输入哈希变了（意图/参考/参数）。重新提交；`--force` 只在确认产物仍有效时用 |
| 长作业断连 | `filmbench jobs collect --job <id> --file <path> --reason "…"` 把远端产物收回账本，不重跑 |
| 会话中途被杀 | `filmbench colab up` 会续装（`phase: provisioning`），不重建、不重下模型 |
| 需要修历史哈希 | `filmbench jobs rehash --job <id> --reason "…"`，必须带理由并落事件日志 |
| 界面白屏 | engine 崩了会自动拉起；⌘R 重载即可 |

## 钱与边界

- 任何花 CU 或付费 API 的作业，**先报告预算与耗时，得到明确同意再跑**；不要自行设置 `IMAGINE_SPEND_OK` / 起 A100。
- 不为让 `check` 变绿去改判定规则；有问题就修产出。
- 不手改 `journal/`、`assets/`、`build/`；不并发抢同一个 GPU 会话。

## 其它入口

```bash
filmbench ui [--shot ID]     # 桌面界面（总览 / 时间轴拖拽 / 审片九宫格 / 成片预览）
filmbench mcp                # stdio MCP（与内置 agent 同一张工具表）
filmbench agent "…"          # 内置 pi agent
filmbench storyboard --embed # 单文件故事板
```

完整方法：仓库 `docs/method.md`；字段级规范：`docs/architecture.md`、`docs/workflows.md`。
