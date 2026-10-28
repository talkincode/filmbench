import { derive } from "./audit.ts";
import type { DerivedShot, Finding, StoryboardDoc, Totals } from "./types.ts";

const esc = (v: unknown): string =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const pad2 = (n: number) => String(n).padStart(2, "0");

function clock(frames: number, fps: number): string {
  const total = frames / fps;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

const money = (n: number) => n.toFixed(2);
const bytes = (n?: number) =>
  n == null
    ? "—"
    : n >= 1e9
      ? `${(n / 1e9).toFixed(2)} GB`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${Math.round(n / 1024)} KB`;
const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

const STATE_LABEL: Record<DerivedShot["state"], string> = {
  ready: "就位",
  stale: "过期",
  missing: "缺产物",
  blocked: "阻塞",
};

const SEV_MARK: Record<Finding["severity"], string> = {
  blocker: "■",
  warning: "▲",
  note: "○",
};

function stat(k: string, v: string, sub: string, cls = ""): string {
  return `<div class="stat ${cls}"><span class="k">${esc(k)}</span><span class="v">${v}${
    sub ? ` <small>${sub}</small>` : ""
  }</span></div>`;
}

function masthead(doc: StoryboardDoc, t: Totals): string {
  const undecided = t.blockers + t.warnings;
  return `<header class="masthead">
  <div>
    <div class="eyebrow"><b>filmbench</b><span>审计故事板 · storyboard audit</span></div>
    <h1>${esc(doc.project.title)}</h1>
    <p class="subtitle">全部 ${t.shots} 个分镜按播放顺序铺开，逐镜核对意图、产物、参考、花费与阻塞；连线即顺序，虚线即依赖。本页是只读投影，不写回任何状态。</p>
    <div class="meta-line">
      <span>项目 <b>${esc(doc.project.name)}</b></span>
      <span>规格 <b>${doc.project.output.width}×${doc.project.output.height} · ${doc.project.fps}fps</b></span>
      <span>修订 <b>${esc(doc.revision.ref)}@${doc.revision.seq}</b></span>
      <span class="hash">${esc(doc.revision.hash.slice(0, 12))}</span>
      <span>阻塞/告警 <b>${t.blockers} / ${t.warnings}</b></span>
    </div>
  </div>
  <div class="stamp" role="img" aria-label="审计印章：修订 ${doc.revision.seq}，${undecided} 项待处理">
    <div class="st-1">审计</div>
    <div class="st-2">rev ${doc.revision.seq} · ${undecided > 0 ? `${undecided} 待处理` : "通过"}</div>
  </div>
</header>
<section class="stats">
  ${stat("镜头 shots", String(t.shots), "")}
  ${stat("时长 runtime", clock(t.frames, doc.project.fps), `${t.frames}f`)}
  ${stat("就位 ready", `${t.ready}/${t.shots}`, `${pct(t.ready, t.shots)}%`, t.ready === t.shots ? "is-ready" : "")}
  ${stat("阻塞 blocked", String(t.blocked), `缺 ${t.missingArtifact} · 过 ${t.flaggedStale}`, t.blocked > 0 ? "is-block" : "")}
  ${stat(
    "花费 spent",
    money(t.costActual),
    `<span class="nw">/ ${money(t.costEstimated)} · ${t.cu.toFixed(2)} CU</span>`,
  )}
  ${stat(
    "预算 budget",
    doc.project.budget ? money(doc.project.budget.limit) : "—",
    doc.project.budget
      ? `${pct(t.costActual, doc.project.budget.limit)}% · 余 ${money(Math.max(0, doc.project.budget.limit - t.costActual))}`
      : "未设",
  )}
</section>`;
}

function strip(doc: StoryboardDoc, shots: DerivedShot[], t: Totals): string {
  const maxFrames = Math.max(...shots.map((s) => s.durationFrames), 1);
  const cells = shots
    .map((s) => {
      const h = Math.round(56 + (s.durationFrames / maxFrames) * 40);
      return `<button class="strip-cell" type="button" data-target="${esc(s.id)}" data-state="${s.state}" style="flex-grow:${s.durationFrames};--h:${h}%" title="${esc(`${pad2(s.order)} ${s.title} · ${s.seconds.toFixed(2)}s · ${s.durationFrames}f`)}"><span class="n">${pad2(s.order)}</span></button>`;
    })
    .join("");

  const end = doc.project.output.durationFrames ?? t.frames;
  const lanes = (doc.audioTracks ?? [])
    .map((track) => {
      const overflow = track.startFrame + track.durationFrames > end;
      const over = Math.max(0, track.startFrame + track.durationFrames - end);
      const left = (track.startFrame / end) * 100;
      const width = (Math.min(track.durationFrames, end - track.startFrame) / end) * 100;
      const cls = ["lane-bar", track.approved === false ? "unapproved" : "", overflow ? "overflow" : ""]
        .filter(Boolean)
        .join(" ");
      return `<span class="lane-name">${esc(track.role)}${
        overflow ? `<em class="lane-over">越界 ${over}f</em>` : ""
      }</span>
      <div class="lane"><span class="${cls}" style="left:${left.toFixed(3)}%;width:${width.toFixed(
        3,
      )}%" title="${esc(`${track.id} · ${track.asset} · ${track.startFrame}+${track.durationFrames}f${
        overflow ? " · 越界" : ""
      }${track.approved === false ? " · 未批准" : ""}`)}"></span></div>`;
    })
    .join("");

  return `<section class="strip-wrap">
  <div class="strip-head">
    <span>播放序列 · 按帧数比例</span>
    <span>总长 ${clock(t.frames, doc.project.fps)} · ${t.frames} 帧 · 点击可跳到该镜</span>
  </div>
  <div class="strip" role="list">${cells}</div>
  <div class="lanes">${lanes || `<span class="lane-name">无音轨</span><div class="lane"></div>`}</div>
</section>`;
}

function findingsBlock(findings: Finding[]): string {
  if (findings.length === 0) return "";
  return `<div class="findings">${findings
    .map(
      (f) => `<p class="finding" data-sev="${f.severity}" title="${esc(f.action)}">
      <span class="mark">${SEV_MARK[f.severity]}</span>
      <span><b>${esc(f.label)}</b>${f.detail ? ` — ${esc(f.detail)}` : ""}</span></p>`,
    )
    .join("")}</div>`;
}

function card(doc: StoryboardDoc, s: DerivedShot): string {
  const [w, h] = [doc.project.output.width, doc.project.output.height];
  const refs = s.references?.length ?? 0;
  const cands = s.candidates?.length ?? 0;
  const checks = s.checks ?? [];
  const passed = checks.filter((c) => c.status === "pass").length;
  const produced = s.produces ?? [];
  const main = produced.find((p) => p.kind === "video") ?? produced[0];
  const spec = main
    ? `${main.width ?? w}×${main.height ?? h}`
    : `${w}×${h}`;
  const cost = s.cost ?? {};
  const spentCell = cost.priceUnknown
    ? `<span class="v warn cost">未计入<em>价格未知</em></span>`
    : `<span class="v cost${(cost.actual ?? 0) > (cost.estimated ?? 0) ? " warn" : ""}">${money(
        cost.actual ?? 0,
      )}${cost.estimated !== undefined ? ` / ${money(cost.estimated)}` : ""}${
        cost.cu ? `<em>${cost.cu.toFixed(2)} CU</em>` : ""
      }</span>`;

  return `<article class="card" id="${esc(s.id)}" data-id="${esc(s.id)}" data-order="${s.order}" data-state="${s.state}" data-flag-missing="${s.missingArtifact ? 1 : 0}" data-flag-stale="${s.staleArtifact ? 1 : 0}" data-flag-blocked="${s.blocked ? 1 : 0}" tabindex="0" title="${esc(`${s.id} · ${s.title}${s.intent.prompt ? `
${s.intent.prompt}` : ""}`)}" aria-label="镜头 ${s.order} ${esc(s.title)}，状态 ${STATE_LABEL[s.state]}">
  <div class="perf" aria-hidden="true"></div>
  <div class="card-main">
    <div class="frame">
      <span class="idx">${pad2(s.order)}</span>
      <span class="badge">${STATE_LABEL[s.state]}</span>
      <div class="guides" aria-hidden="true"></div>
      ${
        main?.preview
          ? `<img class="shot" src="${esc(main.preview)}" alt="${esc(s.title)}" loading="lazy">`
          : s.hasPreview
            ? ""
            : `<div class="missing" aria-hidden="true"><span>暂无产物</span></div>`
      }
      ${
        main && main.exists
          ? `<div class="rec"><span>sha ${esc((main.sha256 ?? "—").slice(0, 7))}</span><span><b>${bytes(main.bytes)}</b></span></div>`
          : ""
      }
      <p class="slate">${esc(s.intent.action ?? s.intent.description ?? "")}</p>
      <div class="spec"><span>${esc(spec)}</span><span>${s.seconds.toFixed(2)}s · ${s.durationFrames}f</span></div>
    </div>
    <div class="body">
      <h3>${esc(s.title)}</h3>
      <p class="intent">${esc(s.intent.description ?? "")}</p>
      <div class="chips">
        <span class="tag">${esc(s.binder.provider)} · ${esc(s.binder.task)}</span>
        ${refs > 0 ? `<span class="tag ref">参考 ${refs}</span>` : ""}
        ${(s.subjects ?? [])
          .map(
            (sub) =>
              `<span class="tag sub${sub.approved === false ? " bad" : ""}">${esc(sub.name)}@${sub.revision}${
                sub.variant ? `·${esc(sub.variant)}` : ""
              }</span>`,
          )
          .join("")}
      </div>
      ${findingsBlock(s.findings)}
      ${
        s.intent.prompt
          ? `<p class="prompt"><span>prompt</span>${esc(s.intent.prompt)}</p>`
          : ""
      }
    </div>
    <div class="rows">
      <div class="row-cell"><span class="k">候选</span><span class="v">${cands} 条${
        s.selected?.video || s.selected?.image ? " · 已选" : " · 未选"
      }</span></div>
      <div class="row-cell"><span class="k">花费</span>${spentCell}</div>
      <div class="row-cell"><span class="k">检查</span><span class="v${
        checks.length > 0 && passed === checks.length ? " ok" : checks.length === 0 ? "" : " warn"
      }">${passed}/${checks.length}</span></div>
    </div>
    ${
      (s.dependsOn ?? []).length > 0
        ? `<div class="card-deps">依赖 ${(s.dependsOn ?? [])
            .map((d) => `<span class="dep-chip">${esc(d.shot)}<i>${esc(d.kind)}</i></span>`)
            .join("")}</div>`
        : ""
    }
    <div class="card-foot">
      <span class="rev">${esc(s.id)} · r${s.provenance?.revisionSeq ?? "—"}</span>
      <span>${esc(s.selected?.video ?? s.selected?.image ?? "未选产出")}</span>
    </div>
  </div>
</article>`;
}

function ledger(findings: Finding[]): string {
  const order: Finding["severity"][] = ["blocker", "warning", "note"];
  const sorted = [...findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.check.localeCompare(b.check),
  );
  const rows = sorted
    .map(
      (f) => `<tr>
      <td class="sev" data-sev="${f.severity}">${SEV_MARK[f.severity]} ${f.severity}</td>
      <td class="check">${esc(f.label)}<span class="cid">${esc(f.check)}</span></td>
      <td class="shot">${f.shot ? `<a href="#${esc(f.shot)}" data-jump="${esc(f.shot)}">${esc(f.shot)}</a>` : "<span>全片</span>"}</td>
      <td>${esc(f.detail ?? f.label)}</td>
      <td class="action">${esc(f.action)}</td>
    </tr>`,
    )
    .join("");

  return `<section class="ledger" id="ledger">
  <h2>审计底账</h2>
  <p class="lede">每条记录都是可判定的机器输出：检查项已登记（未登记项按 <code>check.unknown</code> 记），严重度决定是否阻断出片，处置动作给出下一步。空表意味着本修订无待处理项。</p>
  ${
    sorted.length === 0
      ? `<p class="empty">无待处理项。</p>`
      : `<table>
    <thead><tr><th>严重度</th><th>检查</th><th>镜头</th><th>说明</th><th>处置</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</section>`;
}

export function renderDocument(doc: StoryboardDoc, assets: { css: string; client: string }): string {
  const pictureDoc: StoryboardDoc = {
    ...doc,
    shots: doc.shots.filter((s) => (s.role ?? "picture") === "picture"),
  };
  const { shots, totals, findings } = derive(pictureDoc);
  const clientData = {
    shots: shots.map((s) => ({
      id: s.id,
      order: s.order,
      state: s.state,
      deps: s.dependsOn ?? [],
    })),
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>审计故事板 · ${esc(doc.project.title)}</title>
<meta name="description" content="filmbench 审计故事板：${totals.shots} 个分镜，${totals.blockers} 项阻塞。">
<style>${assets.css}</style>
</head>
<body>
<div class="sheet">
  ${masthead(pictureDoc, totals)}
  ${strip(pictureDoc, shots, totals)}
  <div class="toolbar" role="toolbar" aria-label="故事板视图控制">
    <div class="group" role="group" aria-label="筛选">
      <span class="lbl">筛选</span>
      <button class="chip" type="button" data-filter="all" aria-pressed="true">全部 <span class="cnt">${totals.shots}</span></button>
      <button class="chip" type="button" data-filter="blocked" aria-pressed="false">阻塞 <span class="cnt">${totals.blocked}</span></button>
      <button class="chip" type="button" data-filter="missing" aria-pressed="false">缺产物 <span class="cnt">${totals.missingArtifact}</span></button>
      <button class="chip" type="button" data-filter="stale" aria-pressed="false">过期 <span class="cnt">${totals.flaggedStale}</span></button>
      <button class="chip" type="button" data-filter="ready" aria-pressed="false">就位 <span class="cnt">${totals.ready}</span></button>
    </div>
    <div class="group" role="group" aria-label="连线">
      <span class="lbl">连线</span>
      <button class="chip" type="button" data-thread="seq" aria-pressed="true">顺序</button>
      <button class="chip" type="button" data-thread="dep" aria-pressed="true">依赖</button>
    </div>
    <div class="group" role="group" aria-label="密度">
      <span class="lbl">密度</span>
      <button class="chip" type="button" data-density="comfy" aria-pressed="true">舒适</button>
      <button class="chip" type="button" data-density="dense" aria-pressed="false">紧凑</button>
    </div>
    <div class="spacer"></div>
    <span class="hint">点卡片展开描述 · ⌘P 打印</span>
  </div>
  <noscript><p class="hint">未执行脚本：卡片可直接阅读，顺序连线与依赖连线需要脚本。</p></noscript>
  <div class="board" id="board">
    <svg class="threads deps" id="deps" aria-hidden="true"></svg>
    <div class="grid" id="grid">
      ${shots.map((s) => card(doc, s)).join("\n      ")}
    </div>
    <svg class="threads" id="threads" aria-hidden="true"></svg>
  </div>
  ${ledger(findings)}
  <footer class="colophon">
    <span>schema filmbench/storyboard-audit/v1</span>
    <span>engine ${esc(doc.provenance?.engine ?? "—")}</span>
    <span>ir ${esc((doc.provenance?.irHash ?? "—").slice(0, 12))}</span>
    <span>lock ${esc((doc.provenance?.lockHash ?? "—").slice(0, 12))}</span>
    <span>确定性输出 · 无时间戳 · 单文件 · 无外部依赖</span>
  </footer>
</div>
<script type="application/json" id="sb-data">${JSON.stringify(clientData).replaceAll("<", "\\u003c")}</script>
<script>${assets.client}</script>
</body>
</html>
`;
}
