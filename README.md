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

`filmbench doctor` 一次性体检：ffmpeg / ffprobe / electron / pi / colab(ADC) / imagine（已配置模型数、凭据来源）。

把工具接到别的 agent（Claude Code / Codex / pi）：

```json
{ "mcpServers": { "filmbench": { "command": "bun",
  "args": ["/Users/wangjuntao/github/filmbench/packages/cli/src/cli.ts", "mcp"],
  "cwd": "/Users/wangjuntao/github/filmbench/demo-project" } } }
```

## 需求对照

| 最初的要求 | 现状 | 位置 |
| --- | --- | --- |
| 一个项目，两套协议合并 | ✅ 单一命名空间 `filmbench/v1`：Film 意图 / Event 历史 / Ledger 账本，共用一个 schema 包与一个时间基 | `packages/protocol` |
| 去掉网络性质（服务端形态） | ✅ 无 Worker / 无 D1 / 无 R2 / 无 SSO；项目目录即全部。出站只剩 provider | `docs/architecture.md` |
| Electron | ✅ 主进程 → Bun engine 子进程 → 渲染层（IPC，contextIsolation），单实例 | `apps/desktop` |
| 界面支持编排 | ✅ 缩略图网格 · 项目切换 · 分镜详情抽屉 · 一键提交/执行/出片/故事板；⚠ 拖拽排时间轴未做 | `apps/desktop/src/renderer` |
| 分镜详情（vflow 式） | ✅ 意图 / 绑定 / 主体版本 / 参考 / 候选与选定 / 产物与路径 / 依赖 / 检查 / 花费 / 时间轴 / 作业历史 / 事件 | `packages/core/src/detail.ts` |
| agent 唤起界面 | ✅ `filmbench ui --shot <id>`；MCP 工具 `open_ui`；单实例聚焦并定位镜头 | `packages/tools` |
| 截图 + 框选标注 | ✅ ⌘⇧S 截图 → 框选/矩形/箭头/文字 → 复制图片 或 保存到 `review/` 并复制路径 | `apps/desktop` |
| 调用 imagine 生成素材 | ✅ 已用 MAI-Image-2.6-Flash 真跑通：出图 → 内容寻址 → 编译 → 成片 | `packages/providers` |
| 调用 colab | ✅ 会话适配器：new → exec → download → **finally 无条件 stop** | 同上 |
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
- **顶部动作**：提交待办 / 执行队列 / 出片 / 审计故事板 / 截图
- **截图标注**：`⌘⇧S` → 框选（可裁剪）、矩形、箭头、文字，四种颜色，撤销；「复制图片」进剪贴板，「保存到项目」落到 `<project>/review/markup-*.png` 并把路径复制到剪贴板，可以直接甩给 agent
- **从 agent 唤起**：`filmbench ui --shot shot-003`，或让 agent 调 `open_ui` 工具；已在运行时不会开第二个窗口，而是聚焦并跳到该镜头

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
filmbench storyboard               # 审计故事板 HTML
filmbench ledger --json
filmbench ui [--shot ID]           # 打开桌面界面（单实例）
filmbench doctor
filmbench status | verify | reindex | export
filmbench mcp                      # stdio MCP（给外部 agent）
filmbench agent "<任务描述>"        # 内置 pi agent
filmbench demo [dir]
```

## 文档

- [架构](docs/architecture.md) —— 模块、真相与投影、单写路径、编译、预算、provider 契约、验收面与非目标
- [参考图与 prompt 规范](docs/prompt-guide.md) —— 5 张上限、槽位语义、prompt 结构、机器判定规则
- [审计故事板](packages/storyboard-audit/README.md) —— 投影 schema、检查登记表、网格与连线规则

## 尚未完成

时间轴拖拽编辑；分支/提案（协议留了 `ref`，当前只有 `main`）；`imagine` / `colab` 的真实凭据端到端验证；Electron 打包与签名。

## License

MIT
