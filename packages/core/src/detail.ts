import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRegistry } from "./providers.ts";
import { CHECK_REGISTRY } from "@filmbench/storyboard-audit";
import { hashReferencedFiles, inputsHash } from "./jobs.ts";
import { projectStoryboard } from "./storyboard.ts";
import { totalFrames, type ProjectState } from "./state.ts";
import type { Service } from "./service.ts";

export interface ShotEventRow {
  seq: number;
  op: string;
  at: string;
  actor: string;
  summary: string;
}

/**
 * 分镜详情：一支镜头在系统里的全部信息。
 * 数据来自事件状态 + 故事板投影（检查项同源），所以抽屉里看到的判定与导出的故事板一致。
 */
export function shotDetail(service: Service, registry: ProviderRegistry, shotId: string, ref = "main") {
  const state = service.state(ref);
  const shot = state.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`镜头不存在: ${shotId}`);

  const order = state.shots.findIndex((s) => s.id === shotId);
  const startFrame = state.shots.slice(0, order).reduce((n, s) => n + s.durationFrames, 0);
  const projection = projectStoryboard(service, registry, ref).shots.find((s) => s.id === shotId)!;

  const selection = state.selections.get(shotId);
  const selected = selection?.video ?? selection?.image ?? selection?.audio;
  const abs = (p: string) => (p.startsWith("/") ? p : join(service.dir, p));

  const provider = registry.get(shot.binder.provider);
  const files = hashReferencedFiles(service.dir, shot.binder.params);
  const currentHash = inputsHash(
    shot,
    state.project?.format.fps ?? 30,
    shot.binder.params,
    provider?.modality ?? null,
    undefined,
    files,
  );
  const produceJob = shot.produce ? state.jobs.get(shot.produce.jobId) : undefined;

  const jobs = [...state.jobs.values()]
    .filter((j) => j.shot === shotId)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map((j) => ({
      jobId: j.jobId,
      provider: j.provider,
      task: j.task,
      params: j.params,
      phase: j.phase,
      reason: j.reason ?? null,
      estimate: j.estimate,
      inputsHash: j.inputsHash,
      hasLog: Boolean(j.log?.length),
      asset: j.produce?.asset ?? null,
      atSeq: j.updatedAt,
      requestedAt: j.requestedAt,
    }));

  const produce = shot.produce
    ? {
        kind: shot.produce.kind,
        asset: shot.produce.asset,
        path: shot.produce.path,
        absPath: abs(shot.produce.path),
        exists: existsSync(abs(shot.produce.path)),
        sha256: shot.produce.sha256,
        bytes: shot.produce.bytes,
        width: shot.produce.width,
        height: shot.produce.height,
        durationFrames: shot.produce.durationFrames,
        jobId: shot.produce.jobId,
      }
    : null;

  const jobShot = new Map<string, string>();
  for (const j of state.jobs.values()) jobShot.set(j.jobId, j.shot);
  const costRows = state.ledger.filter((r) => r.jobId && jobShot.get(r.jobId) === shotId);
  const knownCost = costRows.filter((r) => !r.priceUnknown);

  // 与该镜头有关的事件：本镜头写操作 + 其作业的生死
  const jobIds = new Set(jobs.map((j) => j.jobId));
  const events: ShotEventRow[] = state.events
    .filter((e) => {
      const p = e.payload as any;
      if (e.op === "shot.added") return p.shot.id === shotId;
      if (e.op === "shot.patched" || e.op === "shot.removed") return p.id === shotId;
      if (e.op === "selection.set" || e.op === "review.decided") return p.shot === shotId;
      if (e.op.startsWith("job.")) return jobIds.has(p.jobId);
      return false;
    })
    .map((e) => {
      const p = e.payload as any;
      const summary =
        e.op === "shot.added"
          ? `新增镜头 ${p.shot.title}`
          : e.op === "shot.patched"
            ? `改镜头 ${Object.keys(p.patch ?? {}).join(", ") || "（空）"}`
            : e.op === "selection.set"
              ? `选定 ${p.kind} → ${p.asset}`
              : e.op === "review.decided"
                ? `审阅 ${p.decision} ${p.asset}`
                : e.op === "job.requested"
                  ? `提交作业 ${p.provider} · 预估 ${p.estimate.amount} ${p.estimate.currency}`
                  : e.op === "job.completed"
                    ? `作业完成 → ${p.asset}（${p.bytes} 字节）`
                    : e.op === "job.failed" || e.op === "job.rejected"
                      ? `作业${e.op === "job.failed" ? "失败" : "被拒"}：${p.reason}`
                      : e.op;
      return { seq: e.seq, op: e.op, at: e.at, actor: `${e.actor.kind}:${e.actor.id}`, summary };
    });

  const dependents = state.shots
    .filter((s) => s.dependsOn.some((d) => d.shot === shotId))
    .map((s) => ({ shot: s.id, kind: s.dependsOn.find((d) => d.shot === shotId)!.kind }));

  const references = shot.references.map((r) => {
    const asset = state.assets.get(r.asset);
    return {
      asset: r.asset,
      role: r.role,
      registered: Boolean(asset),
      absPath: asset ? abs(asset.path) : null,
      exists: asset ? existsSync(abs(asset.path)) : false,
      mime: asset?.mime ?? null,
    };
  });

  return {
    project: {
      dir: service.dir,
      name: state.project?.name ?? "",
      title: state.project?.title ?? "",
      format: state.project?.format,
      totalFrames: totalFrames(state),
      head: state.head,
    },
    shot: {
      id: shot.id,
      order: order + 1,
      count: state.shots.length,
      title: shot.title,
      durationFrames: shot.durationFrames,
      startFrame,
      endFrame: startFrame + shot.durationFrames,
      seconds: shot.durationFrames / (state.project?.format.fps ?? 30),
      intent: shot.intent,
      binder: shot.binder,
      subjects: shot.subjects.map((pin) => {
        const sub = state.subjects.get(pin.id);
        const approved = Boolean(
          sub && sub.approved && sub.revision === pin.revision && (pin.variant ? sub.variant === pin.variant : true),
        );
        return { ...pin, name: sub?.name ?? pin.id, approved, known: Boolean(sub) };
      }),
      dependsOn: shot.dependsOn,
      dependents,
      references,
      selected: selected ?? null,
      reviewed: selected ? (state.reviews.get(`${shotId}:${selected}`) ?? null) : null,
      produces: projection.produces,
      checks: projection.checks.map((c) => ({
        ...c,
        label: CHECK_REGISTRY[c.id]?.label ?? c.id,
      })),
      candidates: projection.candidates,
    },
    produce,
    inputs: {
      current: currentHash,
      lastProduce: produceJob?.inputsHash ?? null,
      sameAsLast: Boolean(produceJob && produceJob.inputsHash === currentHash),
    },
    provider: provider
      ? { id: provider.id, determinism: provider.determinism, modality: provider.modality ?? null, maxReferences: provider.maxReferences ?? null }
      : null,
    estimate: provider && state.project ? provider.estimate({ shot, format: state.project.format }) : null,
    jobs,
    cost: {
      currency: state.project?.budget?.currency ?? "USD",
      actual: Math.round(knownCost.reduce((n, r) => n + r.amount, 0) * 1000) / 1000,
      estimated: Math.round(
        jobs.reduce((n, j) => n + (j.estimate.priceUnknown ? 0 : j.estimate.amount), 0) * 1000,
      ) / 1000,
      calls: costRows.length,
      priceUnknown: costRows.some((r) => r.priceUnknown),
      rows: costRows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        provider: r.provider,
        units: r.units,
        amount: r.amount,
        currency: r.currency,
        priceUnknown: r.priceUnknown,
      })),
    },
    events,
    revision: { ref, seq: state.head.seq, hash: state.head.hash },
  };
}

export function stateSummary(state: ProjectState) {
  return {
    shots: state.shots.length,
    frames: totalFrames(state),
    events: state.head.seq,
  };
}
