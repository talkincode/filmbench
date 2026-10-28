import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { canonical } from "@filmbench/protocol";
import { remainingBudget, type ShotState } from "./state.ts";
import { PATHS, ValidationError, type Actor, type Service } from "./service.ts";
import { requireProvider, type ProviderRegistry, type ProviderRunResult } from "./providers.ts";

const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

export function inputsHash(shot: ShotState, fps: number): string {
  return sha256(
    Buffer.from(
      canonical({
        id: shot.id,
        durationFrames: shot.durationFrames,
        intent: shot.intent,
        binder: shot.binder,
        subjects: shot.subjects,
        references: shot.references,
        format: { fps },
      }),
    ),
  );
}

export interface SubmitInput {
  shot: string;
  params?: Record<string, string | number | boolean>;
  actor?: Actor;
  opid?: string;
}

export interface SubmitResult {
  jobId: string;
  phase: "requested" | "rejected";
  estimate: { amount: number; currency: string; units: string; priceUnknown: boolean };
  reason?: string;
}

/**
 * 提交作业。预算闸门在调用 provider 之前：超预算不是异常，而是一条 job.rejected 事件，
 * 这样"为什么没生成"永远可解释。
 */
export function submit(service: Service, registry: ProviderRegistry, input: SubmitInput): SubmitResult {
  const state = service.state();
  if (!state.project) throw new ValidationError("项目尚未创建");
  const shot = state.shots.find((s) => s.id === input.shot);
  if (!shot) throw new ValidationError(`镜头不存在: ${input.shot}`);

  const provider = requireProvider(registry, shot.binder.provider);
  if (!provider.tasks.includes(shot.binder.task)) {
    throw new ValidationError(`provider ${provider.id} 不支持 task ${shot.binder.task}`);
  }
  if (provider.maxReferences !== undefined && shot.references.length > provider.maxReferences) {
    throw new ValidationError(
      `${provider.id} 最多接受 ${provider.maxReferences} 张参考图，${shot.id} 有 ${shot.references.length} 张`,
    );
  }

  const params = { ...shot.binder.params, ...(input.params ?? {}) };
  const estimate = provider.estimate({ shot, format: state.project.format });
  const jobId = `job-${shot.id}-${state.jobs.size + 1}`;
  const hash = inputsHash(shot, state.project.format.fps);

  // 先记录请求：被预算拒绝的作业也必须留在队列历史里，否则"为什么没生成"查不到
  service.append(
    "job.requested",
    { jobId, shot: shot.id, provider: provider.id, task: shot.binder.task, params, estimate, inputsHash: hash },
    { actor: input.actor, opid: input.opid },
  );

  if (!estimate.priceUnknown && state.project.budget) {
    const remaining = remainingBudget(state) ?? 0;
    if (estimate.amount > remaining) {
      const reason = `超出剩余预算：需要 ${estimate.amount.toFixed(2)} ${estimate.currency}，剩余 ${remaining.toFixed(2)} ${estimate.currency}`;
      service.append("job.rejected", { jobId, reason }, { actor: input.actor });
      return { jobId, phase: "rejected", estimate, reason };
    }
  }

  return { jobId, phase: "requested", estimate };
}

export interface RunOutcome {
  jobId: string;
  shot: string;
  ok: boolean;
  asset?: string;
  path?: string;
  reason?: string;
}

async function materialize(service: Service, file: { path: string; mime: string }, jobId: string, providerId: string) {
  const bytes = readFileSync(file.path);
  const digest = sha256(bytes);
  const asset = `asset-${digest.slice(0, 12)}`;
  const destDir = join(service.dir, PATHS.assets, digest);
  const dest = join(destDir, basename(file.path));
  if (!existsSync(dest)) {
    mkdirSync(destDir, { recursive: true });
    copyFileSync(file.path, dest);
  }
  service.registerAsset({
    asset,
    sha256: digest,
    bytes: bytes.byteLength,
    mime: file.mime,
    path: relative(service.dir, dest),
    lineage: { provider: providerId, task: "run", jobId },
  });
  return { asset, digest, bytes: bytes.byteLength, path: relative(service.dir, dest) };
}

/** 执行队列。一次一个：本地渲染与 GPU 会话都不适合并发抢资源。 */
export async function runJobs(
  service: Service,
  registry: ProviderRegistry,
  options: { jobId?: string; onLog?: (line: string) => void } = {},
): Promise<RunOutcome[]> {
  const state = service.state();
  if (!state.project) throw new ValidationError("项目尚未创建");
  const pending = [...state.jobs.values()].filter(
    (j) => j.phase === "requested" && (options.jobId ? j.jobId === options.jobId : true),
  );
  const outcomes: RunOutcome[] = [];

  for (const job of pending) {
    const shot = state.shots.find((s) => s.id === job.shot);
    if (!shot) {
      service.append("job.failed", { jobId: job.jobId, reason: `镜头已删除: ${job.shot}` });
      outcomes.push({ jobId: job.jobId, shot: job.shot, ok: false, reason: "镜头已删除" });
      continue;
    }
    const provider = registry.get(job.provider);
    if (!provider) {
      service.append("job.failed", { jobId: job.jobId, reason: `provider 未注册: ${job.provider}` });
      outcomes.push({ jobId: job.jobId, shot: job.shot, ok: false, reason: "provider 未注册" });
      continue;
    }

    service.append("job.started", { jobId: job.jobId });
    try {
      const result: ProviderRunResult = await provider.run({
        shot,
        params: job.params,
        projectDir: service.dir,
        format: state.project.format,
        onLog: options.onLog,
      });
      if (!result.files.length) throw new Error("provider 没有产出任何文件");

      const main = result.files[0];
      if (!existsSync(main.path)) throw new Error(`产物不存在: ${main.path}`);
      const stored = await materialize(service, { path: main.path, mime: main.mime }, job.jobId, provider.id);
      const bytes = stored.bytes;

      service.append("job.completed", {
        jobId: job.jobId,
        kind: main.kind,
        asset: stored.asset,
        sha256: stored.digest,
        bytes,
        width: main.width,
        height: main.height,
        durationFrames: main.durationFrames,
        mime: main.mime,
        path: stored.path,
      });

      if (result.cost) {
        service.append("cost.recorded", {
          jobId: job.jobId,
          kind: result.cost.kind,
          provider: provider.id,
          units: result.cost.units,
          unitPrice: result.cost.unitPrice,
          amount: result.cost.amount,
          currency: result.cost.currency,
          priceUnknown: false,
        });
      } else if (result.priceUnknown) {
        service.append("cost.recorded", {
          jobId: job.jobId,
          kind: "api",
          provider: provider.id,
          units: "call",
          unitPrice: 0,
          amount: 0,
          currency: state.project.budget?.currency ?? "USD",
          priceUnknown: true,
        });
      }

      outcomes.push({ jobId: job.jobId, shot: job.shot, ok: true, asset: stored.asset, path: stored.path });
    } catch (err) {
      const reason = (err as Error).message;
      service.append("job.failed", { jobId: job.jobId, reason });
      outcomes.push({ jobId: job.jobId, shot: job.shot, ok: false, reason });
    }
  }

  return outcomes;
}
