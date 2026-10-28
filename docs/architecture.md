# filmbench 架构

## 一句话

一支视频的全部状态（意图、历史、素材、作业、花费、成片）存在一个项目目录里；GUI、CLI、MCP、内置 agent 都是同一条写入路径的不同入口；编译结果逐字节可复现。

## 模块

```
packages/protocol         filmbench/v1：Film 意图 / Event 历史 / Ledger 账本
packages/core             journal · sqlite 索引 · Service · 作业 · 编译 IR · 账本 · 故事板投影
packages/tools            agent 与 MCP 共用的工具表（一份定义，两种传输）
packages/providers        filmbench/colorcard · imagine · colab · local-proc
packages/agent            内置 pi agent（动态加载，未安装时明确报错）
packages/mcp              stdio MCP 服务端
packages/cli              filmbench 命令行 + engine（给桌面端的 JSON-RPC）
packages/storyboard-audit 独立审计故事板（单文件 HTML）
apps/desktop              Electron 壳（渲染层只走 IPC → engine 子进程）
```

依赖方向是单向的：`protocol → core → tools/providers → cli/mcp/agent → desktop`。故事板不依赖 core（core 依赖它的类型与渲染），所以它既能被项目内调用，也能单独吃一份投影 JSON 出页。

## 真相与投影

| 东西 | 位置 | 谁是权威 |
| --- | --- | --- |
| 历史 | `journal/events/<seq>-<hash>.json` | 权威。append-only，哈希链，`filmbench verify` 可检出任何篡改 |
| 索引导航 | `.filmbench/index.db`（sqlite） | 缓存。删掉可 `filmbench reindex` 重建 |
| 素材 | `assets/<sha256>/<name>` | 内容寻址，不可变 |
| 意图导出 | `film.yaml` | 投影。给人和 agent 读，不参与写入判定 |
| 编译 | `build/render.ir.json` + `build/final.mp4` | 投影 |
| 审计 | `build/storyboard.html` | 投影，单文件 |

**为什么不是 yaml 或 sqlite 当真相**：付费作业、预算拒绝、审阅决定、花费归属都需要带 actor 和时序的历史；同时又要能被删库重建。只有事件日志同时满足这两件事。

## 单写路径

```
GUI(IPC) ┐
CLI      ├─→ Service.append(op, payload, {actor, opid, base})
MCP      │       1. zod 校验载荷（未知 op 直接拒绝）
agent    ┘       2. operationId 幂等（重放返回原事件，不写第二条）
                 3. baseRevision 比对（不匹配 → ConflictError，状态不变）
                 4. 落盘事件 → 写索引
```

`operationId` 与 `baseRevision` 不是为多人协作准备的，是为**三个写入者**：人、内置 agent、外部 MCP 客户端。

## 时间基

内部一律整数帧（`durationFrames`）。秒只出现在两处：故事板与 CLI 的展示、ffmpeg 参数（`.toFixed(6)`）。`compile` 会拒绝"产物帧数 ≠ 镜头声明帧数"的情况，所以出片前就能发现错位，而不是在 ffmpeg 里错。

## 编译与出片

`compile(state, dir)` 是纯函数：状态 → IR。IR 里只有声明（片段、时长、规格、需求），没有命令。出片时才由 `ffmpegArgs(ir)` 生成一条 `filter_complex`：

- 图片先 `-loop 1 -t <该镜头时长>` 变成静帧；
- 视频按 `trim=duration=` 截到声明帧数；
- 统一 `scale/pad/setsar/fps/format` 后 `concat`。

因此混合来源（图片 + 视频 + 不同分辨率）不需要预先归一化。IR 逐字节确定，测试里两次编译必须完全相同。

出片前要求：产物存在、规格匹配、**并且已选定且已审阅批准的素材**。选片是独立一步（`filmbench select`），不是默认生效——这是"未经审阅的产物不能进成片"的结构性保证，而不是文案警告。

## 作业、预算与账本

```
submit → 预算闸门 → job.requested → (超预算) job.rejected
                                    └→ job.started → provider.run
                                        ├→ 成功：内容寻址落盘 → asset.registered → job.completed → cost.recorded
                                        └→ 失败：job.failed（带原因）
```

- 预算 = `limit − 已花 − 在途预估`。拒绝是事件不是异常，所以"为什么没生成"永远可解释。
- 账本按 provider / 计量类型 / 镜头聚合；`priceUnknown` 的行不计入金额、单独计数，绝不记 0。
- provider 的确定性等级决定要不要再花一次钱：`deterministic` 可缓存，`nondeterministic` 必须显式重跑。

## provider 契约

```ts
interface Provider {
  id: string;                          // 允许分层：filmbench/colorcard
  tasks: string[];
  determinism: "deterministic" | "seeded" | "nondeterministic";
  maxReferences?: number;              // 超出即 blocker，提交前就拒绝
  estimate({shot, format}): ProviderEstimate;
  health(): { ok: boolean; detail: string };
  run(input): Promise<{ files: ProviderFile[]; cost?; priceUnknown? }>;
}
```

已实现：

| provider | 能力 | 说明 |
| --- | --- | --- |
| `filmbench/colorcard` | 视频 | 用 ffmpeg lavfi 生成纯色片段，离线、零成本，用来跑通整条链路与做回归 |
| `filmbench/title` | 图片 | 本地渲染片名卡/封面（SVG → PNG，宋体标题 + 红线；可选参考图当底并压暗） |
| `imagine` | 图片 | 调 `imagine generate`，`--authorize-spend`；用 ffprobe 回读真实尺寸；凭据可用 `FILMBENCH_IMAGINE_ENV_FILE` 指向 KEY=VALUE 文件；价格来自 `unitPrice` / `IMAGINE_UNIT_PRICE`，没配就是未知 |
| `colab` | 视频 | 可复用会话：`workflows/<name>` 打包上传，首次 setup（persist 命中跳过），之后复用；空闲 30 分钟由本地 reap 与 VM watchdog 停止 |
| `local-proc` | 自定义 | 任意 CLI 模板（qwentts / scorekit / hyperframes / remotion）接成 provider |

## agent 与 MCP 同源

`packages/tools` 是唯一工具表：`project_state`、`shot_add`、`shot_patch`、`job_submit`、`jobs_run`、`render_build`、`shot_detail`、`open_ui`、`storyboard_projection`、`cost_ledger`、`journal_verify`。

- `filmbench mcp` 把它们暴露成 stdio MCP（真客户端测试覆盖：列工具 → 读状态 → 写镜头 → 校验哈希链）。
- `filmbench agent "<prompt>"` 用 pi SDK 起会话，把同一批工具注册进去。
- 双方写入都落在同一条事件日志上，`operationId` 防重放。

## 桌面端拓扑

```
Electron 渲染层 (apps/desktop/src/renderer)
   ↕ preload (contextIsolation, 只暴露 rpc)
Electron 主进程 (main.mjs)
   ↕ 子进程 stdin/stdout，一行一条 JSON
Bun engine (packages/cli/src/engine.ts)
   ↕
Service / sqlite / ffmpeg / provider
```

engine 是独立进程的原因：core 用 `bun:sqlite`，Electron 的 Node 加载不了；长任务崩了也不该带走窗口。

engine 一个进程服务多个项目（每个项目一个 `Service`），请求里带 `project` 字段；桌面端切换项目只是换 `projectDir`，不重启 engine。主进程持有单实例锁：再次 `filmbench ui --shot x` 不会开新窗口，而是聚焦并把镜头 id 推给渲染层。

## 验收

```bash
bun test                              # core 10 + storyboard 13 + MCP 1
bun packages/cli/src/cli.ts demo /tmp/fb-demo
cd /tmp/fb-demo && filmbench build && filmbench storyboard
```

真实覆盖：哈希链篡改检出、幂等重放、baseRevision 冲突、删库重建、预算拒绝不扣款、真实 ffmpeg 出片（ffprobe 校验 240 帧 / 8.000s）、IR 逐字节确定、未选定时拒绝出片、分镜详情聚合、MCP 客户端全链路。

## 明确的非目标 / 未完成

- 不做实时合成预览：预览只读编译产物。
- 不做账号、协作、ACL、云端存储；本地项目目录即全部。
- 分支/提案（agent 提改动给人审）协议里留了 `ref` 字段，但当前只有 `main` 一条可写分支。
- 时间轴拖拽编辑尚未实现：现在是卡片网格 + 故事板，编排通过命令行/agent 改意图。
- `colab` 适配器需要真实凭据才能端到端验证；`imagine` 同理。
