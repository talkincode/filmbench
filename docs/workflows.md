# 工作流与 provider 契约

两条线要分清：**provider** 是"谁能产出素材"，**workflow** 是"远端环境怎么搭、参数默认值是什么、支持哪些输入"。
两者都必须是声明式的，脚本里不许写死默认值。

## provider（本机能力）

| id | task | 输出 | 说明 |
| --- | --- | --- | --- |
| `filmbench/colorcard` | `clip` | 视频 | ffmpeg 纯色片段，零成本，用于跑通链路 |
| `filmbench/title` | `title` | 图片 | 片名卡/封面（SVG→PNG），四层排版 |
| `filmbench/scorekit` | `music` | 音频 | scene.yaml → WAV；`params.renderer=sfizz` + `orchestration=<profile>` 走真实采样库，`postFilter` 是同一条作业里的母带链（ffmpeg -af） |
| `filmbench/qwentts` | `voice` | 音频 | 本地 TTS；`referenceAudio` 走 base 克隆（男声默认锅哥） |
| `imagine` | `image` | 图片 | `imagine generate`，真实计费 |
| `imagine/video` | `video` | 视频 | 首帧 + 视频 prompt（付费云视频，需 `IMAGINE_SPEND_OK=1`） |
| `colab` | `video` | 视频 | 远端会话 + workflow（见下） |
| `filmbench/remotion` | `render` | 视频 | `remotion render <entry> <composition> <out> --props=<tmp>`；产物按实测尺寸/帧数登记。例子见 `examples/remotion-edit` |
| `filmbench/hyperframes` | `render` | 视频 | `npx hyperframes render <dir> -o <out> -f <fps> [-c <composition>]` |
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
| `postFilter` | 渲染完成后接的 ffmpeg 音频链，母带（高通 / 高音架 / 增益 / 限幅）跟渲染同属一个作业 |
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
