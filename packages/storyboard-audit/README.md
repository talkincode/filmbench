# @filmbench/storyboard-audit

**独立审计故事板。** 把一支视频的全部分镜按播放顺序铺成网格，用一条可追踪的线串起来，逐镜核对意图、产物、参考、花费与阻塞，输出**一个单文件 HTML**：无外部依赖、无网络、无时间戳，可以直接发给别人、进附件、存档、打印。

"独立"指产物独立，不指代码独立——它和 filmbench 的其他包在同一个仓库、同一套 schema 版本里。

## 为什么需要它

分镜评审真正的失败模式不是"看不到画面"，而是**看到画面却看不到状态**：这一镜的图是从哪版角色设定生成的、产物是 90 帧还是 105 帧、这次选定有没有人审过、钱花在哪、哪一镜其实压根还没跑。这些问题在剪辑软件里不可见，在聊天记录里不可查。

故事板把这些问题变成页面上的字段：每个镜头一张卡，卡上有序号、时长、产物指纹、provider、主体版本、候选与选定、花费、以及机器给出的检查结论；网格下方是底账，逐条列出"哪一镜、什么问题、下一步做什么"。

## 用法

```bash
bun src/cli.ts --in fixtures/demo.storyboard.json --out out/storyboard.html
bun src/cli.ts --in p.json --out s.html --exit-on-blocker   # CI 门禁：有阻塞退出 2
bun src/cli.ts --in p.json --out s.html --json              # 机器可读汇总
```

退出码：`0` 正常 · `1` 输入不合法 · `2` 存在阻塞项（`--exit-on-blocker`）。

输出的 HTML 自身可离线打开，工具栏支持：按状态筛选（阻塞/缺产物/过期/就位）、开关顺序线与依赖线、舒适/紧凑密度、点卡片展开完整描述、点胶片条或底账跳到对应镜头、`⌘P` 打印（打印时不过滤）。

## 输入：审计投影

输入是**投影**，不是真相。真相在 filmbench 的事件日志里，投影由 `filmbench project --storyboard` 导出；本包只读不写，也不访问网络。

```jsonc
{
  "apiVersion": "filmbench/storyboard-audit/v1",
  "project": {
    "name": "demo-nightwalk",
    "title": "夜行 · 城市夜跑品牌片",
    "fps": 30,                                    // 时间基：整数帧，秒只用于展示
    "output": { "width": 1920, "height": 1080, "durationFrames": 1620 },
    "budget": { "currency": "USD", "limit": 6 }
  },
  "revision": { "ref": "main", "seq": 42, "hash": "9f3c1ab7…" },
  "shots": [
    {
      "id": "shot-001",                           // 稳定 ID，跨修订不变
      "title": "空镜 · 江面灯带",
      "durationFrames": 120,
      "intent": { "description": "…", "action": "…", "prompt": "…" },
      "binder": { "provider": "imagine", "task": "generate", "params": {} },
      "subjects": [{ "id": "char-nightwalker", "name": "夜行者", "revision": 3, "variant": "cold", "approved": true }],
      "references": [{ "kind": "image", "asset": "asset-8f21c0", "role": "framing", "approved": true }],
      "candidates": [{ "asset": "asset-8f21c0", "actor": "agent-storyboard", "review": "selected" }],
      "selected": { "video": "asset-8f21c0" },
      "produces": [{ "kind": "video", "path": "build/shot-001/clip.mp4",
                     "exists": true, "stale": false, "sha256": "a1b2c3…", "bytes": 8421193,
                     "width": 1920, "height": 1080, "durationFrames": 120 }],
      "dependsOn": [{ "shot": "shot-005", "kind": "continuity" }],
      "checks": [{ "id": "artifact.spec", "status": "pass" }],
      "cost": { "currency": "USD", "estimated": 0.18, "actual": 0.18, "cu": 0.82 },
      "provenance": { "revisionSeq": 41, "approvedBy": "human", "proposal": "proposal-7" }
    }
  ],
  "audioTracks": [
    { "id": "bgm-main", "role": "bgm", "asset": "asset-bgm-01",
      "startFrame": 0, "durationFrames": 1620, "approved": true }
  ],
  "provenance": { "engine": "filmbench-engine/0.1.0", "irHash": "…", "lockHash": "…" }
}
```

关键约定：

- **`exists` 必须由生产者如实给出**，故事板不猜测文件是否存在。`exists: false` 才是"缺产物"的唯一来源。
- **`stale` 表示产物早于意图**（改了 prompt 没重生成）——它和"缺"是两件事，统计分开。
- **`checks` 是数据不是文案**：页面只渲染已登记的检查项，未登记的 id 一律按 `check.unknown` 记为提示，不允许静默通过。
- **`cost.priceUnknown`** 的镜头不参与金额汇总，单独计数，避免把未定价的调用算成 0。
- `durationFrames` 必须是整数帧。

## 检查登记表

| id | 严重度 | 含义 | 处置 |
| --- | --- | --- | --- |
| `artifact.missing` | blocker | 产物不存在或作业未提交 | 提交生成作业，或补齐本地文件后重建索引 |
| `artifact.stale` | warning | 意图/输入变更后未重生成 | 重新生成该镜头的产物 |
| `artifact.spec` | blocker | 产物规格与成片规格不符 | 重生成或修正 provider 参数 |
| `intent.empty` | warning | 镜头意图为空 | 补齐描述与动作，否则不可复现 |
| `reference.unapproved` | blocker | 引用了未批准的主体修订 | 批准该修订，或改绑已批准版本 |
| `reference.limit` | blocker | 参考图数量超出 provider 上限 | 裁剪参考图或换用支持更多的 provider |
| `timeline.duration` | warning | 镜头时长合计 ≠ 成片声明时长 | 对齐时长或调整 durationPolicy |
| `timeline.audio` | warning | 音轨越过片尾 | 修正起点与时长 |
| `budget.estimate` | warning | 预估花费超出剩余预算 | 降低尝试次数或上调预算 |
| `cost.unknown` | note | 该 provider 未登记报价版本 | 补充报价版本 |
| `review.pending` | warning | 候选未审阅即被选定 | 在审阅台确认候选 |
| `provenance.missing` | note | 产物缺少来源记录 | 补齐内容摘要与作业记录 |

新增检查项必须先登记进 `src/audit.ts` 的 `CHECK_REGISTRY`，否则页面会把它显示成"未登记检查项"。

## 网格与连线

- **网格**：自适应列宽（默认约 340px），卡片顺序即播放顺序；每张卡左缘是胶片齿孔，画面区是"片格 + 构图三分线"，右上角是产物收据（sha 前缀与体积），缺失时覆盖斜纹与 `NO ARTIFACT`。
- **顺序线**：行内走列间留白，直连并带箭头；**换行走行间留白**，圆角拐弯后从上方进入下一行首卡，绝不压过卡片内容。
- **筛选时的断点**：被筛掉的镜头不画线，改为虚线并标注"跳过 N 镜"，避免把不连续的镜头伪装成相邻。
- **依赖线**：底图层低透明度绘制，被卡片挡住，只在留白处露出，读起来像"线从卡片背后穿过"；悬停/聚焦某镜时，它相关的依赖边在前景重描，同时**压暗无关卡片**，让长距离依赖可追踪。卡片底部的 `依赖 shot-005·continuity` chip 提供无图形时的可读替代。

## 验收

```bash
bun test
```

13 例覆盖：阻塞与缺产物正交计数、时长/音轨系统级发现、未登记检查项不被当通过、价格未知不计入金额、渲染逐字节确定性、单文件无外部引用、卡片顺序与播放顺序一致、底账条目数与阻塞数一致、CLI 拒绝非法输入、`--exit-on-blocker` 退出码与产物落盘、`--json` 汇总。

## 非目标

- 不写回任何状态，不做审批动作（审批在审阅台，产出事件）。
- 不渲染、不转码、不生成素材。
- 不联网，不读远端素材；页面里的媒体只以路径/摘要形式出现。
- 不做第二套时间轴编辑器——它是审计视图，不是剪辑器。
