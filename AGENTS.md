# AGENTS.md

给在这个仓库里干活的 agent（pi / Claude Code / Codex）看的硬规则。**先读 [docs/method.md](docs/method.md)**，
那是"遇到问题先做什么"的默认动作；这里只写不该踩的线。

## 必须遵守

1. **单一写入路径**：所有改动走 `Service`（GUI / CLI / MCP / agent 同一套），不手改 `journal/`、不改 `filmbench.lock`。
2. **时间是整数帧**。秒只出现在展示与 ffmpeg argv 边界；不要在中间层用浮点秒。
3. **付费动作要人批**：任何会花 CU 或调用付费 API 的作业，先报告预算与耗时，得到明确同意再跑。
   不自行设置 `IMAGINE_SPEND_OK` / `--authorize-spend` / 起 A100 会话。
4. **先审片再出片**：`filmbench check` 全绿 → `review-shot` 看过九宫格 → 才 `build`。
5. **空间关系的问题上 ControlNet**，不要用提示词硬拗（见 method 的升级顺序）。
6. **一次只改一类东西**：改提示词就别同时换种子；重拍后写清"为什么重拍"，结论落 `shot.reviewed`。

## 提交前

```bash
bun test          # 59 例，必须全绿
filmbench check   # 项目级验收（在有项目的目录里）
```

## 不要做

- 不把 `build/`、`assets/`、`journal/` 里的产物当天真值来源——真相是事件日志，`reindex` 能重建成索引。
- 不在 provider 里塞厂商语义（`http` 类 provider 必须声明式、无厂商分支）。
- 不为了让 `check` 变绿去改判定规则；有问题就修产出。
- 不并发跑多个 GPU 作业抢同一个会话。
