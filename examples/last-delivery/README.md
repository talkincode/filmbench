# 最后一单 · 20 秒短片（filmbench 端到端样例）

一支用 filmbench 从零做出来的 20 秒短片：**6 个镜头 / 600 帧 / 1344×768@30fps**，
其中 5 镜是 imagine（Azure MAI-Image-2.6-Flash）真实生成，1 镜是本地 colorcard 占位。

剧本：雨夜，快递员把最后一单放在一栋待拆公寓的门口；电梯是空的；走廊尽头那扇门缝亮着；
门牌是 14 号；包裹被拿走，只剩脚垫上一圈水渍。

```bash
# 成片（不在仓库里，约 1.1 MB）
open ~/github/filmbench-demo/last-delivery/build/final.mp4
# 审计故事板
open ~/github/filmbench-demo/last-delivery/build/storyboard.html
```

## 镜头表

| # | id | 时长 | provider | 说明 |
| --- | --- | --- | --- | --- |
| 01 | `door` | 150f / 5.0s | imagine | 雨夜门厅空镜；后续两镜把它当 `environment` 参考 |
| 02 | `courier` | 120f / 4.0s | imagine | 快递员放下包裹（参考 01） |
| 03 | `lift` | 90f / 3.0s | colorcard | 电梯空轿厢，纯色占位（零成本、确定性） |
| 04 | `hall` | 120f / 4.0s | imagine | 走廊尽头门缝的光（参考 01）；这一镜先失败再修好 |
| 05 | `number` | 60f / 2.0s | imagine | 门牌 14 号特写 |
| 06 | `last` | 60f / 2.0s | imagine | 脚垫上的水渍，切黑收尾 |

依赖：02→01、04→01（continuity），06 接在 05 后。

## 这个样例覆盖了什么

| 能力 | 在这支片子里怎么体现 |
| --- | --- |
| 真实生成 | 5 次 imagine 调用（`--authorize-spend`），产物内容寻址落盘 |
| 参考图 + 槽位 | 01 的产物作为 02/04 的 `environment` 参考；跨镜头复用而不是自引用 |
| 确定性 provider | 03 用 colorcard，重跑产出同一份字节，候选自动去重 |
| 依赖 | 02/04 依赖 01，`dependsOn` 进故事板与详情抽屉 |
| 失败 + 日志 | 04 先用错模型（`not-a-real-model`）提交 → `job.failed`，`filmbench jobs log` 能看到 imagine 的可用模型清单；改回模型后成功 |
| 取消 | 06 先排队再 `jobs cancel`，历史里留 `rejected · cause=cancelled` |
| 过期检测 | 改 03 的 prompt → `plan` 立刻显示「过期」→ 重跑（零成本） |
| 选片 / 审阅 | 六镜逐镜 `select`；02 先 `--reject` 再批准，走完整审阅闸门 |
| 预算 / 账本 | 5 次 imagine 记为 `priceUnknown`（不记 0），colorcard 记 0 |
| 编译 | 图片 `-loop 1 -t`、视频 trim、统一 scale/pad/fps 后 concat，600 帧整 |
| 审计故事板 | `0 镜有阻塞`，底账为空 |

## 复现命令（要真实凭据）

```bash
export FILMBENCH_IMAGINE_ENV_FILE=~/.imagine/azure.env
D=~/github/filmbench-demo/last-delivery
filmbench init "$D" --name last-delivery --title "最后一单" --width 1344 --height 768 --fps 30 --budget 3
cd "$D"
M="--param model=MAI-Image-2.6-Flash --param width=1344 --param height=768"

filmbench shot add --id door --title "门厅 · 雨夜" --frames 150 --provider imagine --task image \
  --prompt "rain-soaked lobby of a condemned apartment building at night, single bare bulb, wet cracked tiles, peeling paint, 35mm cinematic still, cold teal and amber, no people, no text" $M
filmbench shot add --id courier --title "快递员 · 放下包裹" --frames 120 --provider imagine --task image --after door \
  --prompt "a courier in a dark raincoat seen from behind, bending to place a small cardboard parcel on a wet doormat, cold fluorescent light, rain on shoulders, cinematic 35mm still, no text" $M
filmbench shot add --id lift --title "电梯 · 空轿厢" --frames 90 --provider filmbench/colorcard --task clip --after courier --param color=0x0d1114
filmbench shot add --id hall --title "走廊 · 门缝的光" --frames 120 --provider imagine --task image --after lift \
  --prompt "long dim corridor, one door at the far end leaking warm light, wet footprints leading toward it, 35mm anamorphic, teal shadows and amber spill, no people, no text" $M
filmbench shot add --id number --title "门牌 · 14 号" --frames 60 --provider imagine --task image --after hall \
  --prompt "extreme close-up of a scratched brass number plate showing 14 beside a dark doorway, shallow depth of field, no watermark" $M
filmbench shot add --id last --title "脚垫 · 只剩水渍" --frames 60 --provider imagine --task image --after number \
  --prompt "close-up of a wet doormat, a round water stain where a parcel used to be, door closed, single overhead light, melancholic, no people, no text" $M

filmbench jobs submit --shot door && filmbench jobs run
filmbench ref add --shot courier --asset $(filmbench assets | awk 'NR==2{print $1}') --role environment
filmbench ref add --shot hall    --asset $(filmbench assets | awk 'NR==2{print $1}') --role environment
filmbench jobs submit --all && filmbench jobs run        # 跑剩余镜头
filmbench plan && filmbench build && filmbench storyboard
```

> 每支片子第一次跑会花掉几张图的额度；换模型时记得 `filmbench doctor` 看一眼哪些模型真的可用。
