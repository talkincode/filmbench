# filmbench

本地视频编排工作台。一支视频从想法到成片的全部状态——设计、素材、生成作业、花费、编译产物、审阅记录——收在一个项目目录里；人、内置 agent、外部 MCP 客户端在同一份状态上工作；编译结果逐字节可复现。

不做服务端、不做账号、不做协作后端。出站的只有你自己配置的生成 provider（imagine / colab / 自定义 CLI）。

## 现在能跑什么

```bash
bun install
bun test                                    # 24 例：哈希链 / 幂等 / 预算 / 真实 ffmpeg 出片 / MCP 客户端

bun packages/cli/src/cli.ts demo /tmp/fb-demo     # 4 镜 → 作业 → 选定 → 审阅 → IR
cd /tmp/fb-demo
bun <repo>/packages/cli/src/cli.ts build          # 真实 mp4（ffprobe 校验 240 帧 / 8.000s）
bun <repo>/packages/cli/src/cli.ts storyboard     # 单文件审计故事板
bun <repo>/packages/cli/src/cli.ts ledger         # 花费
```

## 需求对照

| 最初的要求 | 现状 | 位置 |
| --- | --- | --- |
| 一个项目，两套协议合并 | ✅ 单一命名空间 `filmbench/v1`：Film 意图 / Event 历史 / Ledger 账本，共用一个 schema 包与一个时间基 | `packages/protocol` |
| 去掉网络性质（服务端形态） | ✅ 无 Worker / 无 D1 / 无 R2 / 无 SSO；项目目录即全部。出站只剩 provider | `docs/architecture.md` |
| Electron | ✅ 主进程 → Bun engine 子进程 → 渲染层（IPC，contextIsolation） | `apps/desktop` |
| 界面支持编排 | ✅ 镜头网格 + 状态 + 作业队列 + 一键出片 + 故事板；⚠ 拖拽时间轴未做 | `apps/desktop/src/renderer` |
| 调用 imagine 生成素材 | ✅ provider（`imagine generate`，`--authorize-spend`，价格可配） | `packages/providers` |
| 调用 colab | ✅ 会话适配器：new → exec → download → **finally 无条件 stop** | 同上 |
| 内置 pi agent 核心 | ✅ pi SDK 会话 + 同源工具注入（需 `bun add @earendil-works/pi-coding-agent`） | `packages/agent` |
| 消耗统计 | ✅ 账本 = 事件投影：按 provider / 计量 / 镜头聚合，未知价格单列 | `packages/core/src/cost.ts` |
| 全功能 stdio MCP | ✅ 与 agent 同一张工具表；真 MCP 客户端测试覆盖读写 | `packages/mcp` |
| sqlite + 本地文件 | ✅ 文件事件日志是真相，sqlite 是索引，删库可重建 | `packages/core/src/{journal,db}.ts` |
| 独立审计故事板 | ✅ 单文件 HTML：网格铺开 + 顺序连线 + 逐镜审计 | `packages/storyboard-audit` |

## 设计上的四条硬约定

1. **真相是事件日志，不是 yaml 也不是 sqlite。** 每次改动都是一个带 actor / `operationId` / `baseRevision` 的 typed 事件；`filmbench verify` 能检出任何篡改；删掉 `.filmbench/index.db` 可从事件重建全部状态。
2. **只有一个写入路径。** GUI、CLI、MCP、内置 agent 都调同一个 `Service`；不存在第二条写逻辑。
3. **时间基只有整数帧。** 秒只在展示与 ffmpeg 参数边界出现；产物帧数与镜头声明不一致，编译阶段就拒绝。
4. **选片与审阅是独立的一步。** 有产物不等于能出片：`select` 之后还要 `review` 批准，未经审阅的候选进不了成片。

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
filmbench status | verify | reindex | export
filmbench mcp                      # stdio MCP（给外部 agent）
filmbench agent "<任务描述>"        # 内置 pi agent
filmbench demo [dir]
```

## 文档

- [架构](docs/architecture.md) —— 模块、真相与投影、单写路径、编译、预算、provider 契约、验收面与非目标
- [审计故事板](packages/storyboard-audit/README.md) —— 投影 schema、检查登记表、网格与连线规则

## 尚未完成

时间轴拖拽编辑；分支/提案（协议留了 `ref`，当前只有 `main`）；`imagine` / `colab` 的真实凭据端到端验证；Electron 打包与签名。

## License

MIT
