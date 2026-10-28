# filmbench

本地视频编排工作台。一支视频从想法到成片的全部状态——设计、素材、生成作业、花费、编译产物、审阅记录——收在一个项目目录里；人、内置 agent、外部 MCP 客户端在同一份状态上工作；编译结果逐字节可复现。

不做服务端、不做账号、不做协作后端。出站的只有你自己配置的生成 provider（imagine / colab / 自定义 CLI）。

## 运行

前置：Bun ≥ 1.2、`ffmpeg` / `ffprobe`（`brew install ffmpeg`）。

```bash
cd filmbench
bun install
bun test                    # 24 例：哈希链 / 幂等 / 预算 / 真实 ffmpeg 出片 / MCP 客户端
bun run demo                # 在 ./demo-project 造一个 4 镜项目并跑完作业
(cd packages/cli && bun link)   # 把 filmbench 装进 PATH（~/.bun/bin），只需一次

cd demo-project
filmbench status            # 没做 bun link 的话用 bun ../packages/cli/src/cli.ts status
bun ../packages/cli/src/cli.ts build       # build/final.mp4
bun ../packages/cli/src/cli.ts storyboard  # build/storyboard.html（直接双击打开）
bun ../packages/cli/src/cli.ts ledger
```

桌面端（Electron）：

```bash
bun run dev                     # = bash scripts/dev.sh：自检依赖 → 备好 demo 项目 → 起界面
bash scripts/dev.sh --check     # 只做环境自检
bash scripts/dev.sh --reset     # 重建 demo 项目
bash scripts/dev.sh --project /path/to/project
```

如果 `bun install` 之后 Electron 报 `Electron failed to install correctly`（二进制没下全），补一次：

```bash
cd node_modules/.bun/electron@*/node_modules/electron
rm -rf dist path.txt
curl -fsSL -o /tmp/electron.zip https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-darwin-arm64.zip
mkdir -p dist && unzip -q /tmp/electron.zip -d dist
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
```

## 真实生成（已在这台机器上跑通）

`imagine` 的凭据放在 `~/.imagine/azure.env`，显式给 engine：

```bash
export FILMBENCH_IMAGINE_ENV_FILE=~/.imagine/azure.env   # dev.sh 会自动带上并打印
filmbench init /tmp/night --name night --title "夜行试片" --width 1344 --height 768 --budget 3
cd /tmp/night
filmbench shot add --id shot-river --title "空镜 · 江边步道" --frames 120 \
  --provider imagine --task image \
  --prompt "cinematic still: empty riverside promenade at night, wet asphalt, teal and amber" \
  --param model=MAI-Image-2.6-Flash --param width=1344 --param height=768
filmbench jobs submit --all
filmbench jobs run          # 真调 imagine（约 13s，价格未知会如实记账）
filmbench select --shot shot-river && filmbench review --shot shot-river
filmbench build             # 1344×768 / 210 帧 / 7.000s
```

试过的结论：

- `MAI-Image-2.6-Flash`（Azure）可用，**height 必须 ≥ 768**，所以 16:9 取 1344×768。
- `doubao-seedream-4/5`、`doubao-seedance-*` 在这台机器的 ARK 账号上 **404（无端点/无权限）**，不是配置问题。
- 图片尺寸和成片不一致是允许的（编译期会 scale+pad）；视频尺寸不一致会直接报 `spec-mismatch`。
- imagine 没有价格数据，账本记 `priceUnknown` 而不是 0；要定价在镜头参数里给 `unitPrice`。

内置 agent 已可用（`pi 1.4.0`）：`filmbench agent "读一下 project_state，告诉我还能不能出片"`。
它会通过同一张工具表调用引擎，写操作以 `actor=agent` 落事件。

`filmbench script set --file script.md [--logline …] | show
filmbench cover --shot ID
filmbench info
filmbench check
filmbench doctor` 一次性体检：ffmpeg / ffprobe / electron / pi / colab(ADC) / imagine（已配置模型数、凭据来源）。

把工具接到别的 agent（Claude Code / Codex / pi）：

```json
{ "mcpServers": { "filmbench": { "command": "bun",
  "args": ["/Users/wangjuntao/github/filmbench/packages/cli/src/cli.ts", "mcp"],
  "cwd": "/Users/wangjuntao/github/filmbench/demo-project" } } }
```

## Remotion 剪辑例子

`examples/remotion-edit/` 是一个**剪辑**形态的 Remotion 工程（不是生成）：三段素材、交叉溶解与滑入、
下三分之一字幕、片名与结尾压字，全部 React 动画，由 `filmbench/remotion` 渲染成镜头产物。

```bash
cd examples/remotion-edit && npm install && node scripts/prepare-clips.mjs
npx remotion render src/index.ts Edit out/edit.mp4     # 360 帧 / 12s / 1280×720@30
```

接进 filmbench 只要四个参数（`cwd` 支持绝对路径）：

```bash
filmbench shot add --id edit --title '剪辑' --frames 360 \
  --provider filmbench/remotion --task render \
  --param cwd=/abs/path/to/examples/remotion-edit --param entry=src/index.ts --param composition=Edit
```

provider 会用 ffprobe **实测**产物尺寸与帧数再登记，composition 尺寸写错会被编译期的 `spec-mismatch`
拦下。跑通的参考工程在 `~/github/filmbench-demo/remotion-edit`（12 秒，附 4 小节 scorekit 配乐，
花费 0，`filmbench check` 全绿）。

## 需求对照

| 最初的要求 | 现状 | 位置 |
| --- | --- | --- |
| 一个项目，两套协议合并 | ✅ 单一命名空间 `filmbench/v1`：Film 意图 / Event 历史 / Ledger 账本，共用一个 schema 包与一个时间基 | `packages/protocol` |
| 去掉网络性质（服务端形态） | ✅ 无 Worker / 无 D1 / 无 R2 / 无 SSO；项目目录即全部。出站只剩 provider | `docs/architecture.md` |
| Electron | ✅ 主进程 → Bun engine 子进程 → 渲染层（IPC，contextIsolation），单实例 | `apps/desktop` |
| 成片预览 | ✅ 「成片预览」直接播最近一次渲染；③ 出片完成后自动打开；总览的成片记录可点播 | `apps/desktop` |
| 界面支持编排 | ✅ 缩略图网格 · 项目切换 · 分镜详情抽屉 · 一键提交/执行/出片/故事板；⚠ 拖拽排时间轴未做 | `apps/desktop/src/renderer` |
| 分镜详情（vflow 式） | ✅ 意图 / 绑定 / 主体版本 / 参考 / 候选与选定 / 产物与路径 / 依赖 / 检查 / 花费 / 时间轴 / 作业历史 / 事件；**内置预览**（视频/图片直接播，可接着截图标注） | `packages/core/src/detail.ts` |
| 影片总览与剧本 | ✅ `filmbench script set/info`，界面「总览」看封面、剧本、镜头表、渠道策略与三步流程 | `packages/core` · `apps/desktop` |
| 片名卡 / 封面 | ✅ `filmbench/title` 四层排版（kicker/title/rule/subtitle/credits）+ 三个预设 + 剧照压暗/暗角/颗粒；`filmbench cover --shot` 设封面 | `packages/providers` · [设计规范](docs/title-design.md) |
| 渠道策略 | ✅ `.filmbench/policy.json` 限制 agent 只能用白名单 provider；视频渠道默认需人工 `--approve` | `packages/core/src/policy.ts` |
| 一键验收 | ✅ `filmbench check`：事件链/剧本/产物/选定/审阅/提示词/编译/审计/预算/封面，`exit 1` 即不通过 | `packages/core/src/check.ts` |
| agent 唤起界面 | ✅ `filmbench ui --shot <id>`；MCP 工具 `open_ui`；单实例聚焦并定位镜头 | `packages/tools` |
| 截图 + 框选标注 | ✅ ⌘⇧S 截图 → 框选/矩形/箭头/文字 → 复制图片 或 保存到 `review/` 并复制路径 | `apps/desktop` |
| 调用 imagine 生成素材 | ✅ 图片：MAI-Image-2.6-Flash 真跑通；🎬 视频：provider + 首帧 + 视频提示词已接好，付费云视频需显式 `IMAGINE_SPEND_OK=1` 授权 | `packages/providers` |
| 配乐 | ✅ `filmbench/scorekit`：scene.yaml → WAV，作为 `role: music` 的音轨混入成片（响度归一 + 淡入淡出） | `packages/providers` |
| 调用 colab | ✅ 可复用会话：装一次环境/模型，之后复用；30 分钟空闲自动停（本地 reap + VM watchdog） | `workflows/comfy-h3` · `packages/providers/src/colab.ts` |
| 内置 pi agent 核心 | ✅ pi 1.4.0 已装，真会话跑通（调用 `project_state` 并正确汇总） | `packages/agent` |
| 消耗统计 | ✅ 账本 = 事件投影：按 provider / 计量 / 镜头聚合，未知价格单列 | `packages/core/src/cost.ts` |
| 全功能 stdio MCP | ✅ 与 agent 同一张工具表；真 MCP 客户端测试覆盖读写 | `packages/mcp` |
| sqlite + 本地文件 | ✅ 文件事件日志是真相，sqlite 是索引，删库可重建 | `packages/core/src/{journal,db}.ts` |
| 独立审计故事板 | ✅ 单文件 HTML：网格铺开 + 顺序连线 + 逐镜审计 | `packages/storyboard-audit` |

## 设计上的四条硬约定

1. **真相是事件日志，不是 yaml 也不是 sqlite。** 每次改动都是一个带 actor / `operationId` / `baseRevision` 的 typed 事件；`filmbench verify` 能检出任何篡改；删掉 `.filmbench/index.db` 可从事件重建全部状态。
2. **只有一个写入路径。** GUI、CLI、MCP、内置 agent 都调同一个 `Service`；不存在第二条写逻辑。
3. **时间基只有整数帧。** 秒只在展示与 ffmpeg 参数边界出现；产物帧数与镜头声明不一致，编译阶段就拒绝。
4. **选片与审阅是独立的一步。** 有产物不等于能出片：`select` 之后还要 `review` 批准，未经审阅的候选进不了成片。

## 界面

`bun run dev` 打开后：

- **左栏**：项目卡（点开切换项目 / 打开目录，非项目可直接初始化）、镜头数/帧数/就位/花费、作业队列、快捷键提示
- **中间**：镜头网格，作业完成后自动抽首帧做缩略图；点任意卡打开右侧详情
- **详情抽屉**：顶部「候选画面」是**横向缩略图队列**（本镜生成出来的版本，点图即切换进片版本，＋ 生成新一版）；下面一条动作栏按"下一步"给出唯一主按钮（提交 / 选定这一版 / 批准 / 再生成）；再往下是「参考图」输入槽位（≤5，带用途与缩略图）、意图与双提示词、绑定、检查、产物、时间轴与依赖、作业历史、事件。**候选是输出，参考是输入**，两个数量本来就不一样
- **顶部动作**：① 提交待办（排队，不花钱）/ ② 执行队列（调用模型，会花钱）/ ③ 出片（本地 ffmpeg，不花钱）/ **成片预览** / 验收 / 总览 / 审计故事板 / 截图。下方常驻一条流程条，实时显示「待生成 N 镜 → 队列 N 个 → 就绪 N/M 镜」，点击任一步就是对应动作
- **截图标注**：`⌘⇧S` → 框选（可裁剪）、矩形、箭头、文字，四种颜色，撤销；「复制图片」进剪贴板，「保存到项目」落到 `<project>/review/markup-*.png` 并把路径复制到剪贴板，可以直接甩给 agent
- **从 agent 唤起**：`filmbench ui --shot shot-003`，或让 agent 调 `open_ui` 工具；已在运行时不会开第二个窗口，而是聚焦并跳到该镜头

## Colab：可复用工作流

```bash
filmbench colab up --workflow comfy-h3   # 建会话（或复用）＋ 上传工作流包 ＋ setup（persist 命中则跳过）
filmbench colab status                   # 会话、存活、空闲分钟数、CU 余额
filmbench colab reap                     # 空闲 ≥ 30 分钟就停
filmbench colab down                     # 立即停
```

- 工作流在 `workflows/comfy-h3/`：`workflow.json`（GPU/依赖/模型/持久化）、`setup.py`（幂等安装）、`run.py`（起 ComfyUI → 提交图 → 取结果）、`watchdog.py`（VM 内 30 分钟空闲自动 `unassign`）、`comfy/workflow.json`（ComfyUI API 图）。
- **只装一次**：`workflow.json` 的哈希写进 persist 目录的 marker；模型文件存在就不重下。persist 建议指向 Google Drive（`colab drivemount /content/drive`），VM 被回收也不重装。
- **只建一次会话**：作业之间复用；只有工作流文件变了才会 stop + 重建。
- **30 分钟空闲自动停**：engine 每 60 秒 reap 一次；即使 filmbench 关掉，VM 里的 watchdog 也会自己 unassign。

作业里指定工作流：`--param workflow=comfy-h3`；换 GPU：`filmbench colab up --gpu A100`。

> 状态（在本机实测）：会话创建、上传、解包、幂等 setup（clone ComfyUI + 模型检查 + watchdog）、心跳、状态文件、空闲停止**全部跑通**；
> `workflows/comfy-h3` 里的 `models[].url` 还是占位地址，**没有真实权重就不会出视频**——把地址换成你的 ckpt（或先手工放进 persist 目录）后即可。
> 另：`colab exec` 的退出码恒为 0，远端脚本必须自己打印 `__FB_OK__` / `__FB_FAIL__`，filmbench 靠这个判断成败。
> 长任务（装环境、下模型、推理）一律**后台执行 + 轮询**（`launch.py` / `check.py`），否则 colab exec 的长单元格会掉连接。

### 已验证：A100 出视频

`workflows/t2v-diffusers`（ModelScope T2V 1.7B，diffusers）在 A100 上端到端跑通：

```bash
filmbench colab up --workflow t2v-diffusers --gpu A100     # 会话 + 模型缓存
filmbench shot add --id t2v --title A100生成 --frames 60 --provider colab --task video \
  --prompt "a courier places a small parcel on a wet doormat at night, cinematic" \
  --param workflow=t2v-diffusers --param numFrames=16 --param steps=16
filmbench jobs submit --shot t2v && filmbench jobs run      # 后台生成 → 回传 → 内容寻址
filmbench colab down
```

实测：A100（5.30 CU/hr），16 帧 / 16 步 → 2 秒 1344×768 H.264，单次作业端到端约 2 分钟（模型已缓存时）。
输出原生 256×256，`run.py` 直接放大 + 补边到成片规格（会看到左右黑边），不适合最终交付画质，适合"先用起来"。

## 配乐

音乐不是"背景音随便垫一下"，它和画面一样是可审计的产物：

```bash
filmbench shot add --id score --title "配乐 · 雨夜铺底" --frames 600 --role music \
  --provider filmbench/scorekit --task music \
  --param scene=music/score.yaml --param volume=0.9 --param fadeIn=2 --param fadeOut=3
filmbench jobs submit --shot score && filmbench jobs run
filmbench select --shot score && filmbench review --shot score
filmbench build      # 混入成片：AAC 48kHz 立体声
```

- `scene.yaml` 用 [scorekit](https://github.com/talkincode/scorekit) 的场景 DSL（key/tempo/bars/harmony/tracks/clips/story/performance）；需要精确写谱时用 `clips`（pitched 给绝对音高、percussion 给 GM 鼓件），按拍位落音；
- **改了 scene.yaml 会让音轨过期**：被引用文件（scene / cues / 脚本）的内容哈希也算进输入，改文件必须重跑；
- 音轨镜头 `role: music` **不占画面时间**，帧数统计与故事板卡片都会把它排除，只出现在音轨泳道；
- 混音链：`loudnorm(I=-18,TP=-2)` → `volume` → 淡入/淡出，多个音轨走 `amix`；
- 产物同样走内容寻址、选定、审阅，`filmbench check` 会把它算进"每镜有产物"。

### 旁白（role: voice）

```bash
filmbench shot add --id vo-open --title "旁白 · 没有地址" --frames 90 --role voice \
  --provider filmbench/qwentts --task voice --narration "这一单，没有地址。" \
  --param startFrame=60 --param voice=Serena --param emotion=low
```

- 本地 Qwen3-TTS 生成（qwentts skill），产物是音频，**时长以实际生成为准**；
- 男声独白走 base 克隆：`--param model=base --param referenceAudio=<speaker.mp3>`（默认用 skill 里的「锅哥男声」），
  不传则走 CustomVoice 预置音色（`--param voice=Serena`）；
- `startFrame` 决定入点，**必须在剪辑点上**（与音乐卡点同一套校验），否则 `build` 拒绝；
- 有旁白时音乐自动避让：`sidechaincompress` 用旁白做侧链压音乐，旁白 -16 LUFS / 音乐 -18 LUFS；
- `build` 会顺带写出 `build/narration.srt`（按句切分、按字数分配时间，近似字幕，不做强制对齐）。

### 音轨卡点（fit: exact）

音乐不是"铺上去就行"，剪辑点要落在乐句边界上：

```jsonc
// music/score.cues.json —— 中立卡点文件，和哪家音乐工具无关
{ "apiVersion": "filmbench/cues-v1", "kind": "Cues",
  "tempo": 60, "beatsPerBar": 2, "cues": [{ "bar": 0 }, { "bar": 1 }, …] }
```

```bash
filmbench shot param --id score --set fit=exact \
  --set cues=music/score.cues.json --set tolerance=0.06
filmbench cues            # 打印每个剪辑点最近的小节边界与偏差
```

- 校验对象是**每个画面剪辑点**：必须在容差内落在某个段落边界，否则 `build` 直接拒绝（`cues-misaligned`）；
- `filmbench check` 里也有一项「音乐卡点」，能过就说明音画同步是可证明的，不是听感；
- 小节的秒数由 `tempo × beatsPerBar` 算出，所以改 tempo/bars 或改镜头时长都会立刻被这项检查抓出来。

## 命令

```bash
filmbench init <dir> --name demo --width 1920 --height 1080 --fps 30 --budget 5
filmbench shot add --id s1 --title 开场 --frames 90 --provider filmbench/colorcard --task clip --prompt "..."
filmbench plan                     # 每镜状态 + 下一步该做什么
filmbench jobs submit --all        # 过预算闸门
filmbench jobs run                 # 执行队列（串行）
filmbench select --shot s1         # 选定（默认取最新产物）
filmbench review --shot s1         # 批准；--reject 否决
filmbench build                    # 编译 + ffmpeg 出片
filmbench storyboard [--embed]     # 审计故事板 HTML（--embed 内联预览图，可单文件外发）
filmbench ledger --json
filmbench colab up|status|down|reap
filmbench ui [--shot ID]           # 打开桌面界面（单实例）
filmbench script set --file script.md [--logline …] | show
filmbench cover --shot ID
filmbench info
filmbench check
filmbench doctor
filmbench status | verify | reindex | export
filmbench mcp                      # stdio MCP（给外部 agent）
filmbench agent "<任务描述>"        # 内置 pi agent
filmbench demo [dir]
```

## 文档

- [架构](docs/architecture.md) —— 模块、真相与投影、单写路径、编译、预算、provider 契约、验收面与非目标
- [工作流与 provider 契约](docs/workflows.md) —— 声明式 workflow（defaults/capabilities）、H3 i2v/ref2v、Three.js 录制、Remotion/HyperFrames
- [片名卡与封面设计](docs/title-design.md) —— 四层结构、三个预设、怎么根据剧情写标题
- [参考图与 prompt 规范](docs/prompt-guide.md) —— 5 张上限、槽位语义、prompt 结构、机器判定规则
- [审计故事板](packages/storyboard-audit/README.md) —— 投影 schema、检查登记表、网格与连线规则

## 尚未完成

时间轴拖拽编辑；分支/提案（协议留了 `ref`，当前只有 `main`）；`imagine` / `colab` 的真实凭据端到端验证；Electron 打包与签名。

## License

MIT
