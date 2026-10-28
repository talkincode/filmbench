# Remotion 剪辑例子

一个"**剪辑**"而不是"生成"的 Remotion 例子：三段素材、两处转场、字幕与片名都是 React 动画，
由 filmbench 的 `filmbench/remotion` provider 渲染成镜头产物，再走选片 → 审阅 → 编译出片。

```
examples/remotion-edit/
├── src/index.ts        registerRoot
├── src/Root.tsx        <Composition id="Edit" 1280×720@30 · 360 帧>
├── src/Edit.tsx        TransitionSeries：片名 → 荆门关 → 舵塔 → 九歌台 + 结尾压字
├── scripts/prepare-clips.mjs   把素材放进 public/clips/（仓库不带 15MB 视频）
└── remotion.config.ts  jpeg 中间帧 + 并发 6
```

## 时间线

| 帧 | 秒 | 内容 | 手法 |
| --- | --- | --- | --- |
| 0–90 | 0–3.0 | 片名「沿水而行」 | 底图压暗 + 反向推镜，kicker 先入、字距收紧、细线展开 |
| 90–186 | 3.0–6.2 | 荆门关 | 交叉溶解 14 帧，下三分之一：编号 + 地名 + 一句说明（线先拉开、文字上浮） |
| 186–282 | 6.2–9.4 | 无岸城 · 舵塔 | 横向滑入 14 帧，Ken Burns 反向 |
| 282–360 | 9.4–12.0 | 九歌台 | 溶解进入，字幕先退出，再压「水路未尽」并淡出 |

转场用 `@remotion/transitions`（`fade()` / `slide()` + `linearTiming`），动画一律
`useCurrentFrame()` + `interpolate()`（CSS transition/animation 在逐帧渲染里不成立）。

## 自己跑

```bash
cd examples/remotion-edit
npm install
node scripts/prepare-clips.mjs      # 有本地录制就复制，没有就生成测试片段
npx remotion studio                 # 预览（可选）
npx remotion render src/index.ts Edit out/edit.mp4
```

## 接进 filmbench

在项目里加一个镜头，provider 指向这个目录即可（`cwd` 支持绝对路径）：

```bash
filmbench shot add --id edit --title '剪辑：三段素材 + 溶解 + 动态字幕' \
  --frames 360 --provider filmbench/remotion --task render \
  --param cwd=/abs/path/to/examples/remotion-edit \
  --param entry=src/index.ts --param composition=Edit
filmbench jobs run
filmbench select --shot edit && filmbench review --shot edit
filmbench build
```

`filmbench/remotion` 会跑 `node_modules/.bin/remotion render <entry> <composition> <out> --props=<tmp>`，
然后把产物按**实测**尺寸与帧数登记（不是照抄项目声明），所以 composition 尺寸写错会在
编译阶段被 `spec-mismatch` 拦下来，而不是悄悄出一支拉变形的片子。

参考工程：`~/github/filmbench-demo/remotion-edit`（1280×720@30，12 秒，附带一支 4 小节的
scorekit 配乐，全部走 provider，花费 0）。
