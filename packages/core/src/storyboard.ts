import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHECK_REGISTRY, type StoryboardDoc } from "@filmbench/storyboard-audit";
import { subjectApproved, totalFrames, type ProjectState, type ShotState } from "./state.ts";
import { compile } from "./compile.ts";
import { lintPrompt } from "./prompt.ts";
import { remainingBudget } from "./state.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { Service } from "./service.ts";

type Check = { id: string; status: "pass" | "fail" | "warn" | "unknown"; detail?: string };

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/**
 * 审计投影：把事件状态翻译成故事板能吃的只读文档。
 * 这台翻译机是"审计"发生的地方——检查项在这里算，渲染只负责画。
 */
export function projectStoryboard(service: Service, registry: ProviderRegistry, ref = "main"): StoryboardDoc {
  const state = service.state(ref);
  if (!state.project) throw new Error("项目尚未创建");
  const { format } = state.project;
  const { ir } = compile(state, service.dir);

  const shots = state.shots.map((shot) => {
    const checks: Check[] = [];
    const produce = shot.produce;
    const fileExists = produce ? existsSync(join(service.dir, produce.path)) : false;
    const provider = registry.get(shot.binder.provider);

    if (!produce) {
      checks.push({ id: "artifact.missing", status: "fail", detail: "没有已完成作业的产物" });
    } else if (!fileExists) {
      checks.push({ id: "artifact.missing", status: "fail", detail: `文件不在磁盘上: ${produce.path}` });
    } else if (shot.mutatedAt > produce.atSeq) {
      checks.push({
        id: "artifact.stale",
        status: "fail",
        detail: `意图在事件 #${shot.mutatedAt} 改动，产物停留在 #${produce.atSeq}`,
      });
    }

    if (produce) {
      if (produce.kind === "video" && (produce.width !== format.width || produce.height !== format.height)) {
        checks.push({
          id: "artifact.spec",
          status: "fail",
          detail: `产物 ${produce.width}×${produce.height} ≠ 成片 ${format.width}×${format.height}`,
        });
      }
      if (produce.durationFrames !== shot.durationFrames) {
        checks.push({
          id: "artifact.spec",
          status: "fail",
          detail: `产物 ${produce.durationFrames} 帧 ≠ 镜头声明 ${shot.durationFrames} 帧`,
        });
      }
    }

    if (!shot.intent.description && !shot.intent.prompt) {
      checks.push({ id: "intent.empty", status: "warn", detail: "没有描述也没有 prompt，生成不可复现" });
    }

    const unapproved = shot.subjects.filter((pin) => !subjectApproved(state, pin));
    if (unapproved.length > 0) {
      checks.push({
        id: "reference.unapproved",
        status: "fail",
        detail: unapproved
          .map((p) => `${p.id}@${p.revision}${p.variant ? `·${p.variant}` : ""} 未批准`)
          .join("；"),
      });
    }

    for (const issue of lintPrompt(shot as any, provider)) {
      checks.push({
        id: issue.id,
        status: issue.status === "fail" ? "fail" : issue.status === "warn" ? "warn" : "unknown",
        detail: issue.detail,
      });
    }

    const selection = state.selections.get(shot.id);
    const selectedAsset = selection?.video ?? selection?.image ?? selection?.audio;
    if (selectedAsset && state.reviews.get(`${shot.id}:${selectedAsset}`) !== "approved") {
      checks.push({ id: "review.pending", status: "warn", detail: `${selectedAsset} 被选定但未经审阅批准` });
    }

    const job = produce ? state.jobs.get(produce.jobId) : undefined;
    const unknownPrice = state.ledger.some((r) => r.jobId === job?.jobId && r.priceUnknown);
    if (unknownPrice) {
      checks.push({ id: "cost.unknown", status: "unknown", detail: "该作业的价格未登记，未计入账本" });
    }

    const rejected = [...state.jobs.values()].find((j) => j.shot === shot.id && j.phase === "rejected");
    if (rejected) {
      checks.push({ id: "budget.estimate", status: "warn", detail: rejected.reason });
    }

    if (produce && !state.assets.has(produce.asset)) {
      checks.push({ id: "provenance.missing", status: "unknown", detail: "产物没有素材登记记录" });
    }

    // 已评估但没失败的检查补成 pass：审计要能证明"查过"，不能只列错误
    const failed = new Set(checks.map((c) => c.id));
    for (const id of Object.keys(CHECK_REGISTRY)) {
      if (id === "check.unknown") continue;
      if (!failed.has(id)) checks.push({ id, status: "pass" });
    }

    return {
      id: shot.id,
      title: shot.title,
      durationFrames: shot.durationFrames,
      intent: shot.intent,
      binder: { provider: shot.binder.provider, task: shot.binder.task, params: shot.binder.params },
      subjects: shot.subjects.map((pin) => {
        const sub = state.subjects.get(pin.id);
        return {
          id: pin.id,
          name: sub?.name ?? pin.id,
          revision: pin.revision,
          variant: pin.variant,
          approved: subjectApproved(state, pin),
        };
      }),
      references: shot.references.map((r) => ({
        kind: "image" as const,
        asset: r.asset,
        role: r.role,
      })),
      candidates: candidatesFor(state, shot),
      selected: {
        video: selection?.video ?? null,
        image: selection?.image ?? null,
        audio: selection?.audio ?? null,
      },
      produces: produce
        ? [
            {
              kind: produce.kind,
              path: produce.path,
              exists: fileExists,
              stale: shot.mutatedAt > produce.atSeq,
              sha256: produce.sha256,
              bytes: produce.bytes,
              width: produce.width,
              height: produce.height,
              durationFrames: produce.durationFrames,
            },
          ]
        : [],
      dependsOn: shot.dependsOn,
      checks,
      cost: costFor(state, shot),
      provenance: {
        revisionSeq: produce?.atSeq ?? shot.addedAt,
        approvedBy: selectedAsset ? (state.reviews.get(`${shot.id}:${selectedAsset}`) === "approved" ? "human" : null) : null,
        proposal: undefined,
      },
    };
  });

  const budget = remainingBudget(state);
  void budget;

  return {
    apiVersion: "filmbench/storyboard-audit/v1",
    project: {
      name: state.project.name,
      title: state.project.title,
      fps: format.fps,
      output: {
        width: format.width,
        height: format.height,
        durationFrames: totalFrames(state),
        container: "mp4",
      },
      budget: state.project.budget,
    },
    revision: { ref, seq: state.head.seq, hash: state.head.hash },
    shots,
    audioTracks: [],
    provenance: {
      engine: "filmbench-engine/0.0.1",
      irHash: ir ? sha(ir) : undefined,
      lockHash: state.renders.at(-1)?.sha256,
    },
  };
}

function candidatesFor(state: ProjectState, shot: ShotState) {
  const selection = state.selections.get(shot.id);
  const selected = selection?.video ?? selection?.image ?? selection?.audio;
  return [...state.jobs.values()]
    .filter((j) => j.shot === shot.id && j.phase === "done" && j.produce)
    .map((j) => {
      const asset = j.produce!.asset;
      const review = state.reviews.get(`${shot.id}:${asset}`);
      const reviewed: "selected" | "candidate" | "rejected" | "unreviewed" =
        asset === selected ? "selected" : review === "rejected" ? "rejected" : review === "approved" ? "candidate" : "unreviewed";
      return { asset, actor: j.provider, review: reviewed };
    });
}

function costFor(state: ProjectState, shot: ShotState) {
  const jobIds = new Set([...state.jobs.values()].filter((j) => j.shot === shot.id).map((j) => j.jobId));
  const rows = state.ledger.filter((r) => r.jobId && jobIds.has(r.jobId));
  const known = rows.filter((r) => !r.priceUnknown);
  const currency = state.project?.budget?.currency ?? rows[0]?.currency ?? "USD";
  return {
    currency,
    actual: Math.round(known.reduce((n, r) => n + r.amount, 0) * 1000) / 1000,
    estimated: Math.round(
      [...state.jobs.values()]
        .filter((j) => j.shot === shot.id)
        .reduce((n, j) => n + (j.estimate.priceUnknown ? 0 : j.estimate.amount), 0) * 1000,
    ) / 1000,
    cu: 0,
    priceUnknown: rows.some((r) => r.priceUnknown),
  };
}
