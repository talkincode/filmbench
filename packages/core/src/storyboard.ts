import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHECK_REGISTRY, type StoryboardDoc } from "@filmbench/storyboard-audit";
import { subjectApproved, totalFrames, type ProjectState, type ShotState } from "./state.ts";
import { compile } from "./compile.ts";
import { shotStale } from "./stale.ts";
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
  const abs = (p: string) => (p.startsWith("/") ? p : join(service.dir, p));
  const { ir } = compile(state, service.dir);

  const shots = state.shots.map((shot) => {
    const checks: Check[] = [];
    const produce = shot.produce;
    const fileExists = produce ? existsSync(join(service.dir, produce.path)) : false;
    const provider = registry.get(shot.binder.provider);
    const selection = state.selections.get(shot.id);

    if (!produce) {
      checks.push({ id: "artifact.missing", status: "fail", detail: "没有已完成作业的产物" });
    } else if (!fileExists) {
      checks.push({ id: "artifact.missing", status: "fail", detail: `文件不在磁盘上: ${produce.path}` });
    } else if (shotStale(state, shot)) {
      checks.push({
        id: "artifact.stale",
        status: "fail",
        detail: `输入变了，产物停留在 #${produce.atSeq}；重新生成即可`,
      });
    }

    if (produce) {
      // fit: scale 允许混合来源：画幅不同交给 ffmpeg 归一化，只有"比声明短"才是硬伤
      const allowScale = shot.binder.params.fit === "scale";
      if (!allowScale && produce.kind === "video" && (produce.width !== format.width || produce.height !== format.height)) {
        checks.push({
          id: "artifact.spec",
          status: "fail",
          detail: `产物 ${produce.width}×${produce.height} ≠ 成片 ${format.width}×${format.height}`,
        });
      }
      if (produce.kind === "video" && produce.durationFrames < shot.durationFrames) {
        checks.push({
          id: "artifact.spec",
          status: "fail",
          detail: `产物只有 ${produce.durationFrames} 帧，短于镜头声明 ${shot.durationFrames} 帧`,
        });
      } else if (!allowScale && produce.kind === "video" && produce.durationFrames !== shot.durationFrames) {
        checks.push({
          id: "artifact.spec",
          status: "fail",
          detail: `产物 ${produce.durationFrames} 帧 ≠ 镜头声明 ${shot.durationFrames} 帧`,
        });
      }
    }

    if ((shot.role ?? "picture") !== "picture") {
      return {
        id: shot.id,
        title: shot.title,
        role: shot.role,
        durationFrames: shot.durationFrames,
        intent: shot.intent,
        binder: { provider: shot.binder.provider, task: shot.binder.task, params: shot.binder.params },
        subjects: [],
        references: [],
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
                preview: null,
                path: produce.path,
                exists: fileExists,
                stale: shotStale(state, shot),
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
        provenance: { revisionSeq: produce?.atSeq ?? shot.addedAt, approvedBy: null, proposal: undefined },
      };
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

    const selectedAsset = selection?.video ?? selection?.image ?? selection?.audio;
    if (produce && shot.references.some((r) => r.asset === produce.asset)) {
      checks.push({
        id: "reference.self-output",
        status: "warn",
        detail: "参考图里包含本镜自己的产物：这会让模型把自己的输出再喂给自己（首/尾帧也应是来源镜头或独立图）",
      });
    }
    if (selectedAsset && produce && selectedAsset !== produce.asset) {
      checks.push({
        id: "selection.stale",
        status: "warn",
        detail: `选定的是 ${selectedAsset}，最新产物是 ${produce.asset}：重新生成后要重新选定`,
      });
    }
    if (selectedAsset && state.reviews.get(`${shot.id}:${selectedAsset}`) !== "approved") {
      checks.push({ id: "review.pending", status: "warn", detail: `${selectedAsset} 被选定但未经审阅批准` });
    }

    const job = produce ? state.jobs.get(produce.jobId) : undefined;
    const unknownPrice = state.ledger.some((r) => r.jobId === job?.jobId && r.priceUnknown);
    if (unknownPrice) {
      checks.push({ id: "cost.unknown", status: "unknown", detail: "该作业的价格未登记，未计入账本" });
    }

    const rejected = [...state.jobs.values()].find(
      (j) => j.shot === shot.id && j.phase === "rejected" && j.rejectCause === "budget",
    );
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
      role: shot.role ?? "picture",
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
              preview:
                produce.kind === "image"
                  ? abs(produce.path)
                  : existsSync(join(service.dir, "build/posters", `${produce.asset}.jpg`))
                    ? join(service.dir, "build/posters", `${produce.asset}.jpg`)
                    : null,
              path: produce.path,
              exists: fileExists,
              stale: shotStale(state, shot),
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
    audioTracks: state.shots
      .filter((s) => (s.role ?? "picture") !== "picture" && s.produce)
      .map((s) => {
        const sel = state.selections.get(s.id);
        const asset = sel?.audio ?? sel?.video ?? sel?.image ?? s.produce!.asset;
        return {
          id: s.id,
          role: (s.role === "voice" ? "voiceover" : "bgm") as "voiceover" | "bgm",
          asset,
          startFrame: 0,
          durationFrames: s.produce!.durationFrames,
          approved: state.reviews.get(`${s.id}:${asset}`) === "approved",
        };
      }),
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
  // 同一份素材可能被多个作业产出（确定性 provider 重跑）；候选按 asset 去重，保留最后一次
  const byAsset = new Map<string, { asset: string; actor: string; review: "selected" | "candidate" | "rejected" | "unreviewed" }>();
  for (const job of state.jobs.values()) {
    if (job.shot !== shot.id || job.phase !== "done" || !job.produce) continue;
    const asset = job.produce.asset;
    const review = state.reviews.get(`${shot.id}:${asset}`);
    byAsset.set(asset, {
      asset,
      actor: job.provider,
      review:
        asset === selected
          ? "selected"
          : review === "rejected"
            ? "rejected"
            : review === "approved"
              ? "candidate"
              : "unreviewed",
    });
  }
  return [...byAsset.values()];
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
