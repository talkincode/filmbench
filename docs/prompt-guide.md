# 参考图与 prompt 规范

这套规则是从 vflow 的参考素材制作规范里挑出**能机器判定**的那部分，落到 filmbench 的镜头模型上。不可判定的（"这张脸像不像"）不在这里假装能判，它们仍然是人的事。

## 先分清两个概念

| 界面位置 | 是什么 | 谁产生 | 数量含义 |
| --- | --- | --- | --- |
| 详情抽屉顶部「候选画面」 | 这个镜头**生成出来**的画面（作业产物） | 作业完成时入册 | 2 个 = 跑过两版，可点选哪一版进片 |
| 下方「参考图」 | 喂给模型的**输入** | 你/agent 从已登记素材里挑 | 3/5 = 用了 5 张里的 3 张 |

两者数量不同是正常的：候选是输出，参考是输入。同一个素材既可能是某镜的输出、又是另一镜的参考（比如上一镜的成片当下一镜的首帧），但**不能是本镜自己的输出**——那等于把模型自己的结果再喂回去，`reference.self-output` 会提醒。

## 每个分镜最多 5 张参考图

上限来自目标工具的实际能力（`imagine` 的图生图 5 张、`colab` 的 H3 Ref2VA 3 张），协议层再兜一道：

```yaml
references:
  - { asset: asset-3c77a1, role: identity }     # 角色长相，正面/侧面/三分之四
  - { asset: asset-3c77a2, role: wardrobe }     # 同一角色的服装/身体
  - { asset: asset-77bb10, role: environment }  # 地点与光线基准
  - { asset: asset-c001,   role: first_frame }  # 只是首帧，不是身份图
  - { asset: asset-9021fe, role: style }        # 质感/调色参考
```

| role | 它是什么 | 它不是什么 |
| --- | --- | --- |
| `identity` | 一个角色的脸 | 不是服装板，不是首帧 |
| `wardrobe` | 同一角色的身体与服装 | 不能和脸混在一张图里 |
| `prop` | 一件道具的多角度/结构 | 不混场景 |
| `environment` | 一个地点的几何与光 | 天气/时间变化要另建 |
| `layout` | 空间布局、轴线、支撑面 | 不能冒充人物参考 |
| `first_frame` / `last_frame` | 视频的首/尾帧 | 不能当身份或环境参考 |
| `style` | 质感、调色、颗粒 | 不含具体主体 |
| `other` | 还没分类 | 出现它就意味着你欠一次整理 |

槽位不可互换：把首帧塞进 `identity`，模型会认真地把那一帧的构图当成长相。

## 两条 prompt 分开写

`intent.prompts.image` 与 `intent.prompts.video` 是两件事：

- **image**：静态构成——主体、姿势、机位、光线、材质、风格。
- **video**：变化——动作方向、时间顺序、运镜、起止状态。

`intent.prompt` 是兜底：哪个模态没单独写，就用它。提交时按 provider 的模态取对应的那条。

推荐顺序（不是硬性，但缺哪段就会被 lint 提醒）：

```
主体（谁/什么） → 动作/状态 → 机位与焦段 → 光线与色彩 → 材质/风格 → 否定项
```

本机实测可用的例子（Azure MAI，高度必须 ≥768）：

```
cinematic still: empty riverside promenade at night, wet asphalt reflecting
city light bands, slow lateral dolly, 35mm, teal and amber, no people, no text
```

## 机器判定的四条规则

`filmbench prompt lint` 与故事板「检查」用的是同一套：

| 检查 | 严重度 | 触发条件 |
| --- | --- | --- |
| `prompt.missing` | 阻断 | provider 需要 prompt（imagine / colab），但对应模态是空的 |
| `prompt.thin` | 警告 | 少于 24 字符——主体/动作/机位大概率没交代 |
| `prompt.long` | 提示 | 超过 900 字符——把不变的部分交给参考图 |
| `prompt.text-leak` | 警告 | 出现「字幕/编号/标注/标题/箭头/水印」却没有明确 `no text` |
| `reference.limit` | 阻断 | 超过 5 张（协议）或超过 provider 上限（colab 3 张） |
| `reference.roles` | 警告 | 有参考图但全是 `other` |
| `reference.identity` | 警告 | 绑定了主体，却没有 `identity` 参考图 |

`prompt.missing` 与 `reference.limit` 在**提交作业前**就拦住，不会先花钱再报错。

## 命令

```bash
filmbench ref add --shot shot-river --asset asset-c001 --role environment
filmbench ref list --shot shot-river
filmbench ref remove --shot shot-river --asset asset-c001
filmbench prompt set --shot shot-river --image "…" --video "…"
filmbench prompt lint [--shot shot-river]
```

界面里等价：详情抽屉的「参考」区有 5 个槽位（下拉改用途、✕ 移除、+ 添加从已登记素材里选），「意图」区两个 prompt 文本框失焦即保存。

## 一条容易忽略的因果

改参考图或 prompt 会让已有产物**过期**（`artifact.stale`），因为它们是生成输入的一部分（`inputsHash` 包含它们）。这是对的：参考换了，旧画面就不再代表当前意图。过期不等于要删，重新提交一次即可，旧产物还留在候选里可比。
