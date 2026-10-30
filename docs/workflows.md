# 工作流与 provider 契约

两条线要分清：**provider** 是"谁能产出素材"，**workflow** 是"远端环境怎么搭、参数默认值是什么、支持哪些输入"。
两者都必须是声明式的，脚本里不许写死默认值。

## provider（本机能力）

| id | task | 输出 | 说明 |
| --- | --- | --- | --- |
| `filmbench/colorcard` | `clip` | 视频 | ffmpeg 纯色片段，零成本，用于跑通链路 |
| `filmbench/title` | `title` | 图片 | 片名卡/封面（SVG→PNG），四层排版 |
| `filmbench/lyria` | `music` | 音频 | Google Lyria（Gemini API `generateContent` + `responseModalities:["AUDIO"]`）；需要 `GEMINI_API_KEY`；`imagine` 0.8 没有音乐后端，所以直接调 |
| `filmbench/scorekit` | `music` | 音频 | scene.yaml → WAV；`params.renderer=sfizz` + `orchestration=<profile>` 走真实采样库，`postFilter` 是同一条作业里的母带链（ffmpeg -af） |
| `filmbench/qwentts` | `voice` | 音频 | 本地 TTS；`referenceAudio` 走 base 克隆（男声默认锅哥） |
| `imagine` | `image` | 图片 | `imagine generate`，真实计费 |
| `imagine/video` | `video` | 视频 | 首帧 + 视频 prompt（付费云视频，需 `IMAGINE_SPEND_OK=1`） |
| `colab` | `video` | 视频 | 远端会话 + workflow（见下） |
| `filmbench/remotion` | `render` | 视频 | `remotion render <entry> <composition> <out> --props=<tmp>`；产物按实测尺寸/帧数登记。例子见 `examples/remotion-edit` |
| `filmbench/hyperframes` | `render` | 视频 | `hyperframes render <dir> -o <out> -f <fps>`；产物按实测尺寸/帧数登记。例子见 `~/github/filmbench-demo/jingmen-site` |
| `filmbench/browser` | `capture` | 视频 | headless Chrome 逐帧渲染 HTML/Three.js，页面暴露 `window.__seek(frame)` |
| `filmbench/import` | `import` | 视频/图片/音频 | 把已有文件（外部录制、别人给的音乐）登记成一次作业产物，零转码；长度按实测校验 |

约定：
- `estimate()` 必须给金额或显式 `priceUnknown`；
- `maxReferences` 声明上限，超出在**提交前**拦截；
- 本地/确定性 provider 记 0 成本，远程 provider 必须落 `cost.recorded`。

## workflow 定义 `filmbench/workflow/v1`

```json
{
  "schema": "filmbench/workflow/v1",
  "name": "h3-i2v",
  "title": "MiniMax H3 首尾帧图生视频",
  "gpu": "A100",
  "defaults": { "width": 768, "height": 1024, "length": 124, "fps": 24, "steps": 24, "seed": 7101 },
  "capabilities": { "firstFrame": true, "lastFrame": true, "referenceImages": false, "referenceVideos": false },
  "models": ["diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "..."],
  "run": "run.py", "setup": "setup.py", "out": "/content/filmbench/out/{jobId}.mp4",
  "pips": [], "env": {}
}
```

规则：
1. `defaults` 必须包含 width/height/length/steps/seed/fps —— `run.py` 只读这里，不再自带兜底。
2. `capabilities` 与镜头的实际输入比对：提供了不支持的输入（比如给 `h3-i2v` 塞参考图）直接报错，不静默丢弃。
3. 会话身份哈希只看 `workflow.json + setup.py`；改 `run.py` / `graph.json` 不会重建会话、重下模型（脚本每次作业前上传）。
4. `models` 是从 `Comfy-Org/MiniMax-H3` 取的相对路径清单，setup 负责下载并软链到 `ComfyUI/models`。
5. 远端脚本必须打 `__FB_OK__` / `__FB_FAIL__` 哨兵；长任务走 `launch.py` + `check.py` 后台执行。

## 已实现的两个 H3 工作流

| | `h3-i2v`（fl2va） | `h3-ref2v`（ref2va） |
| --- | --- | --- |
| 输入 | 首帧必填、尾帧可选 | 参考图 1–9 张（prompt 用 `<Picture i>`） |
| 节点 | `MiniMaxH3ImageToVideo` | `MiniMaxH3ReferenceToVideo` |
| 画幅 | 默认 **768×1024（3:4）** | 同左 |
| 长度 | 吸附到 `17k+5`，限制 124–362（训练区间） | 同左 |
| 草稿/正式 | turbo LoRA 8 步 / 无 LoRA 24 步 | 24 步 |
| 状态 | 已端到端验证（A100，107→124 帧） | 已实现，**待一次真机验证**（autogrow 输入 `ref_images` 的 API 形状需现场确认） |

参考视频（`ref_videos`，2–15s @24fps，≤3 条）与参考音频（≤3）节点已支持，本版本没有接进 workflow。

## Three.js / 3D 白模录制

`filmbench/browser` 的契约是"**确定性帧 URL**"：页面读取 `?frame=N`，调用 `window.__seek(N)` 同步渲染第 N 帧；provider 用 headless Chrome 逐帧截图，再用 ffmpeg 按工程 fps 编码。

关键点（已踩过）：
- **不能加 `--disable-gpu`**，否则 WebGL 初始化失败；
- 必须给 `--virtual-time-budget`（默认 8000ms），否则模块 import/首帧未完成就截图 → 全黑。

示例：`scenes/box.html`（Three.js 盒子阵 + 相机推进），`--frames 60` 两秒出片。

## Remotion / HyperFrames

- Remotion：在镜头参数里给 `cwd`（项目目录）、`entry`、`composition`、`props`；provider 优先用项目自带 `node_modules/.bin/remotion`，否则 `npx -y remotion`。
- HyperFrames：给 `project`（含 `index.html` 的目录）或 `composition`；provider 调 `npx -y hyperframes render`，输出 mp4。

两者都是本地渲染、零成本、确定性；`doctor` 只校验 node/npx 是否在。

## 配乐渲染与母带

`filmbench/scorekit` 的四个可选参数决定"听起来像不像成品"：

| 参数 | 作用 |
| --- | --- |
| `renderer` | `sfizz` 用 SFZ 采样库逐轨渲染，比默认 SF2 高一档；`fluidsynth` / `timidity` 仍是默认兜底 |
| `orchestration` | sfizz 专用的编排 profile（如 ScoreData 的 `hybrid-cinematic.yaml`），决定每个逻辑音色落到哪个真实库 |
| `soundfont` | 非 sfizz 时指定 SF2 |
| `postFilter` | 渲染完成后接的 ffmpeg 音频链，母带（高通 / 高音架 / 增益 / 限幅 / 压缩）跟渲染同属一个作业 |
| `postIR` / `postIRMix` | 卷积混响：干声 + 一条 IR 做 `afir`（sfizz 没有环境级，房间只能这么做） |
| `space` / `master` / `masterTruePeak` | scorekit 0.9 的房间与响度；`space` 非 dry 只对 SF2 后端有效，sfizz 会被拒绝 |
| `gain` | scorekit 自身的输出增益 |

母带做完的音轨要同时给镜头加 `normalize=false`：编译期默认会跑 `loudnorm` 拉齐响度，
那是给旁白和素材音轨用的；它会重排力度关系（轻的地方抬起来、顶点压下去），
把配乐的曲线抹平。`normalize=false` 时只保留一个安全限幅器（`alimiter level=false`）。

## Remotion 剪辑（实跑验证）

`filmbench/remotion` 的参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `cwd` | 否 | Remotion 工程根目录，相对项目根或**绝对路径**；默认项目根 |
| `entry` | 否 | 入口文件，默认 `src/index.ts` |
| `composition` | 是 | composition id，尺寸/时长由它自己决定 |
| `props` | 否 | 会写成 `.filmbench/tmp/<shot>.props.json` 传给 `--props` |

约定：
- provider 用 **ffprobe 实测**产物尺寸与帧数，不照抄项目声明——composition 写错尺寸会在编译期
  被 `spec-mismatch` 拦下，而不是悄悄出一支变形的片子；
- 有本地 `node_modules/.bin/remotion` 就用它，没有才退回 `npx -y remotion`（慢、要联网）；
- 渲染只负责"这一镜"，剪辑点与音轨仍由 filmbench 的编译 IR 决定，两者不互相越界。

完整例子：`examples/remotion-edit/`（三维素材 + 交叉溶解 + 动态字幕 + 结尾压字，12 秒）。

## 作业的输入哈希什么时候算

`job.requested` 记一份，`job.completed` 再按**运行时**的镜头状态重算一份——provider 实际读到的是后者。
提交之后才挂参考图，产物不会因此被判过期；改过参数、换了参考，下一次照样过期。

历史记录里如果哈希停在提交时（旧版本行为），用显式命令修正，必须带理由并落事件日志：

```bash
filmbench jobs rehash --job job-h1-camp-6 --reason "参考图在提交后挂上，产物用的就是这张首帧"
```

它只改这一条记录的哈希；之后任何输入变化都会让镜头重新变成"过期"。这不是给过期开的后门，
是修一条写错的记录。

## 作业断开之后：collect

远端作业可能比本地 CLI 的 30 分钟超时更长，或者连接被掐断——产物仍在远端，不该为了记一笔账再花一次 GPU：

```bash
colab download --session <s> /content/filmbench/out/<jobId>.mp4 .filmbench/collected/<jobId>.mp4
filmbench jobs collect --job <jobId> --file .filmbench/collected/<jobId>.mp4 --reason "CLI 超时被杀，远端已产出"
```

`collect` 会用**当前**镜头状态重算输入哈希、按内容寻址落库、把作业标成 done，
并在 `job.log` 里留下原因。它不验证内容对不对——那是审阅那一步的事。

### 会话中途断掉之后

`colab up` 在**建完会话的那一刻**就把状态写盘，phase 标成 `provisioning`；setup + heartbeat 都过了才改成 `ready`。
装环境要几十分钟（pip + 几十 GB 模型），进程被杀、连接断掉都很常见，所以：

| 下次 `up` 看到 | 行为 |
| --- | --- |
| 状态 `ready` + 会话活着 + 工作流没变 | 直接复用 |
| 状态 `provisioning` + 会话活着 | **续装**：重传工作流、再跑一遍 setup.py（脚本自己看 marker，装好的部分跳过），不重建会话、不重下模型 |
| 会话不在 / 工作流定义变了（`workflow.json` + `setup.py` 的哈希变了） | 停掉旧的，重建 |

决策是纯函数 `colabReuseDecision()`，六种情况都有测试覆盖。

## 总线限幅

多条音轨相加很容易顶到 0 dBFS（尤其"配乐 + 声音设计"两层都有瞬态）。`build` 在 amix 之后固定挂一个
`alimiter=limit=0.79:level=false`，再交给编码器；单轨的 `alimiter` 只管自己那一路，管不了总和。
0.79（≈ −2 dBFS）是留给 AAC 预留的：真峰值在编码后会比采样峰值高 1 dB 左右。

## 九宫格审片

一镜出问题，通常是"细节错误"——构件悬空、锤子砸在手、水面静止、旗幡上有伪汉字。
这些机器判不了，但可以把它摆到一张图上，让人或 agent 一眼看全。

```bash
filmbench review-shot --shot h5-river            # 抽 9 帧拼 3×3，跑机器规则
filmbench review-shot --shot h5-river --record \
  --finding "前景水面波纹九帧不变，只有锤落处有水花" --severity error
filmbench review-shot --open                      # 全部镜头过一遍，直接打开第一张
```

产出：

| 东西 | 内容 |
| --- | --- |
| `build/reviews/<shot>-grid.png` | 3×3 九宫格，帧号写进 JSON（首尾各留 2%） |
| 机器规则 | `black`（黑场）/ `freeze`（连续 0.5s 无变化）/ `flat`（画面内部对比度低）/ `static-background`（9 区里 6 区不动）/ `no-arc`（整段亮度没起伏） |
| 指标 | `meanLuma`、`contrast`（每帧内部标准差取平均）、`lumaSpread`、`motion`、`staticRegions` |
| 事件 | `shot.reviewed`：图路径、帧号、findings、指标；`--finding` 追加人看出来的语义问题 |

两条设计取舍：

- **冻结对设计类产物只报 info**：片名卡与图纸卡本来就接近静止，`filmbench/title` / `hyperframes` /
  `colorcard` 的冻结不该算错。
- **机器只报"能测的"**：`static-background` 在近景里是正常的（浅景深背景本来不动），
  所以它是 warn 而不是 error；语义判断留给人或 agent，但结论一样进事件日志。

MCP 侧同名工具 `review_shot`（`findings` 参数逐条写），agent 与 MCP 共用同一实现。

## ControlNet（h3-i2v）

`workflows/h3-i2v` 的 `controlVideo` 把一段控制视频喂给 `MiniMaxH3FunControlNetApply`：

| 参数 | 含义 |
| --- | --- |
| `controlVideo` | 项目内相对路径；provider 会先上传到作业目录，run.py 再放进 ComfyUI/input |
| `controlStrength` | 默认 1.0 |
| `controlStart` / `controlEnd` | 默认 0.0 / 0.6 —— 后半段放开，让模型自己补细节 |

接线的坑（记下来，别再踩）：`ModelPatchLoader`（节点 34）只是个载荷，必须显式接进采样链；
正式档会删掉 turbo LoRA 节点，所以 patch 的 `model` 入参要指向底模节点 1，指向 2 会 `KeyError: '2'`。

控制视频的写法：**只描述"东西在哪、往哪动"，不描述材质与光**。我们用的是"深度式灰模"——
越近越亮，255 贴脸 / 20 远景，按画家顺序覆盖（不是取较亮者，否则远处的洞永远画不到崖壁上）。
生成脚本见 `filmbench-demo/jingmen-site/scripts/make-control-h4.py`。
