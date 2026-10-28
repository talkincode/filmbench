import type {
  DerivedShot,
  Finding,
  Severity,
  Shot,
  StoryboardDoc,
  Totals,
} from "./types.ts";

/**
 * 检查登记表：一个审计项的存在理由、严重度与处置动作。
 * 新增检查必须先登记，未登记的 check id 一律渲染为 unknown —— 不允许静默通过。
 */
export const CHECK_REGISTRY: Record<string, { label: string; severity: Severity; action: string }> = {
  "artifact.missing": {
    label: "产物缺失",
    severity: "blocker",
    action: "提交生成作业，或补齐本地文件后重建索引",
  },
  "artifact.stale": {
    label: "产物已过期",
    severity: "warning",
    action: "意图或输入已变更，重新生成该镜头的产物",
  },
  "artifact.spec": {
    label: "产物规格不符",
    severity: "blocker",
    action: "按成片规格重生成，或修正 provider 参数",
  },
  "prompt.missing": {
    label: "缺少生成 prompt",
    severity: "blocker",
    action: "在 intent.prompts.<模态> 里补主体、动作、机位与光线",
  },
  "prompt.thin": {
    label: "prompt 过短",
    severity: "warning",
    action: "补齐主体/动作/机位，避免模型自由发挥",
  },
  "prompt.long": {
    label: "prompt 过长",
    severity: "note",
    action: "把不变的部分交给参考图，prompt 只留本次变化",
  },
  "prompt.text-leak": {
    label: "prompt 可能生成文字",
    severity: "warning",
    action: "显式写 no text / 无字幕，或去掉文字类描述",
  },
  "reference.roles": {
    label: "参考图缺用途",
    severity: "warning",
    action: "给每张参考图选 identity/wardrobe/environment/first_frame 等槽位",
  },
  "reference.identity": {
    label: "缺少身份参考",
    severity: "warning",
    action: "为已绑定主体加一张 identity 参考图",
  },
  "intent.empty": {
    label: "意图为空",
    severity: "warning",
    action: "补齐镜头描述与动作，否则生成不可复现",
  },
  "reference.unapproved": {
    label: "引用未批准修订",
    severity: "blocker",
    action: "在审阅台批准该主体修订，或改绑已批准版本",
  },
  "reference.limit": {
    label: "参考图超上限",
    severity: "blocker",
    action: "裁剪参考图到 provider 上限，或在编排中换用支持更多参考的 provider",
  },
  "timeline.duration": {
    label: "时长合计不一致",
    severity: "warning",
    action: "对齐声明时长与镜头帧数，或调整 durationPolicy",
  },
  "timeline.audio": {
    label: "音轨越界",
    severity: "warning",
    action: "修正音轨起点与时长，避免越过片尾或被裁切",
  },
  "budget.estimate": {
    label: "预估超预算",
    severity: "warning",
    action: "降低该镜头尝试次数，或上调项目预算后再提交",
  },
  "cost.unknown": {
    label: "价格未知",
    severity: "note",
    action: "补充该 provider 的报价版本，否则账本无法归属花费",
  },
  "selection.stale": {
    label: "选定落后于产物",
    severity: "warning",
    action: "重新生成后重新选定（filmbench select --shot …）",
  },
  "review.pending": {
    label: "选定未审阅",
    severity: "warning",
    action: "在审阅台确认候选后再进入成片",
  },
  "provenance.missing": {
    label: "缺少来源记录",
    severity: "note",
    action: "产物需带内容摘要与作业记录，否则无法复现",
  },
  "check.unknown": {
    label: "未登记检查项",
    severity: "note",
    action: "把该检查项登记进登记表，或从投影中移除",
  },
};

export function deriveShot(shot: Shot, order: number, fps: number): DerivedShot {
  const findings: Finding[] = [];

  for (const check of shot.checks ?? []) {
    const reg = CHECK_REGISTRY[check.id];
    if (check.status === "pass") continue;
    if (check.status === "unknown" && !reg) continue;
    findings.push({
      check: check.id,
      severity: reg?.severity ?? "note",
      label: reg?.label ?? "未登记检查项",
      action: reg?.action ?? CHECK_REGISTRY["check.unknown"].action,
      shot: shot.id,
      detail: check.detail,
    });
  }

  const produces = shot.produces ?? [];
  const anyMissing = produces.length === 0 || produces.some((p) => !p.exists);
  const anyStale = produces.some((p) => p.exists && p.stale);
  const state: DerivedShot["state"] = findings.some((f) => f.severity === "blocker")
    ? "blocked"
    : anyMissing
      ? "missing"
      : anyStale
        ? "stale"
        : "ready";

  return {
    ...shot,
    order,
    seconds: shot.durationFrames / fps,
    state,
    findings,
    missingArtifact: anyMissing,
    staleArtifact: anyStale,
    blocked: findings.some((f) => f.severity === "blocker"),
    selectedApproved: Boolean(
      shot.selected &&
        (shot.selected.video || shot.selected.image) &&
        (shot.candidates ?? []).some(
          (c) =>
            (c.asset === shot.selected?.video || c.asset === shot.selected?.image) &&
            c.review === "selected",
        ),
    ),
    hasPreview: produces.some((p) => p.exists && (p.kind === "image" || p.kind === "video")),
  };
}

export function derive(doc: StoryboardDoc): { shots: DerivedShot[]; totals: Totals; findings: Finding[] } {
  const fps = doc.project.fps;
  const shots = doc.shots.map((s, i) => deriveShot(s, i + 1, fps));
  const findings = shots.flatMap((s) => s.findings);

  // 时长与音轨的系统级检查（镜头级之外）
  const totalFrames = shots.reduce((n, s) => n + s.durationFrames, 0);
  const declared = doc.project.output.durationFrames;
  if (declared !== undefined && declared !== totalFrames) {
    findings.push({
      check: "timeline.duration",
      severity: CHECK_REGISTRY["timeline.duration"].severity,
      label: CHECK_REGISTRY["timeline.duration"].label,
      action: CHECK_REGISTRY["timeline.duration"].action,
      detail: `镜头合计 ${totalFrames} 帧（${(totalFrames / fps).toFixed(2)}s），成片声明 ${declared} 帧（${(declared / fps).toFixed(2)}s），差 ${declared - totalFrames} 帧`,
    });
  }
  const end = declared ?? totalFrames;
  for (const t of doc.audioTracks ?? []) {
    const overflow = t.startFrame + t.durationFrames - end;
    if (overflow > 0) {
      findings.push({
        check: "timeline.audio",
        severity: CHECK_REGISTRY["timeline.audio"].severity,
        label: CHECK_REGISTRY["timeline.audio"].label,
        action: CHECK_REGISTRY["timeline.audio"].action,
        detail: `音轨 ${t.id}（${t.role}）越过片尾 ${overflow} 帧`,
      });
    }
  }

  const currency = doc.project.budget?.currency ?? "USD";
  const costOf = (s: DerivedShot) => {
    if (s.cost?.priceUnknown) return 0;
    return s.cost?.actual ?? 0;
  };
  const estOf = (s: DerivedShot) => {
    if (s.cost?.priceUnknown) return 0;
    return s.cost?.estimated ?? 0;
  };
  const round = (n: number) => Math.round(n * 1000) / 1000;

  const totals: Totals = {
    shots: shots.length,
    missingArtifact: shots.filter((s) => s.missingArtifact).length,
    flaggedStale: shots.filter((s) => s.staleArtifact).length,
    frames: totalFrames,
    seconds: totalFrames / fps,
    ready: shots.filter((s) => s.state === "ready").length,
    stale: shots.filter((s) => s.state === "stale").length,
    missing: shots.filter((s) => s.state === "missing").length,
    blocked: shots.filter((s) => s.state === "blocked").length,
    blockers: findings.filter((f) => f.severity === "blocker").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    notes: findings.filter((f) => f.severity === "note").length,
    costEstimated: round(shots.reduce((n, s) => n + estOf(s), 0)),
    costActual: round(shots.reduce((n, s) => n + costOf(s), 0)),
    cu: round(shots.reduce((n, s) => n + (s.cost?.cu ?? 0), 0)),
    currency,
    unknownPriceShots: shots.filter((s) => s.cost?.priceUnknown).length,
    audioFrames: (doc.audioTracks ?? []).reduce((n, t) => n + t.durationFrames, 0),
  };

  return { shots, totals, findings };
}
