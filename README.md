# filmbench

本地视频编排工作台。一支视频从想法到成片的全部状态——设计、素材、生成作业、花费、编译产物、审阅记录——收在一个项目里；人、内置 agent、外部 agent 在同一份状态上工作，编译结果确定可复现。

当前仓库处于起步阶段：设计见下方"架构约定"，已落地的包见"包"一节。

## 包

| 包 | 状态 | 说明 |
| --- | --- | --- |
| [`packages/storyboard-audit`](packages/storyboard-audit) | 已实现 | 独立审计故事板：全部镜头网格铺开、按播放顺序连线、逐镜核对意图/产物/参考/花费/阻塞，输出单文件 HTML |

```bash
bun install                       # 目前零第三方依赖，仅需 Bun ≥ 1.2
bun test                          # 13 例：审计判定、渲染确定性、CLI 契约
bun run storyboard:demo           # 用示例投影渲染 out/storyboard.html
```

## 架构约定

这些不是可选偏好，是后续所有包都要遵守的硬约定：

1. **真相是一条 append-only 事件日志。** 设计改动、素材登记、生成作业、选定、审批、花费都是 typed 事件，带 actor、`baseRevision`、`operationId`、哈希链。yaml / sqlite / 故事板 / lock 全部是投影，删掉可重建。
2. **单一写入路径。** GUI（IPC）、CLI、stdio MCP、内置 agent 只调用同一个 Service；不存在第二套写逻辑，也不存在第二套状态。
3. **时间基只有一个。** 内部权威是输出 fps 下的整数帧，秒只出现在给人看的展示层和 ffmpeg argv 里。
4. **预览走编译产物。** 不做第二套实时合成渲染器；draft 与成片共用同一条 IR。
5. **花费是事件，不是报表。** 每次付费调用写 `cost.recorded`；价格表是版本化数据；未知价格是显式状态，永不记 0。
6. **出站网络只经 provider 层。** 白名单以外的 socket 视为缺陷；素材齐全的项目必须能离线出片。

## 目录

```
packages/storyboard-audit/   审计故事板（生成器 + 示例投影 + 测试）
```

## License

MIT
