import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { canonical, promptFor } from "@filmbench/protocol";
import { remainingBudget, type ShotState } from "./state.ts";
import { PATHS, ValidationError, type Actor, type Service } from "./service.ts";
import { requireProvider, type ProviderRegistry, type ProviderRunResult } from "./providers.ts";
import { policyViolation, readPolicy } from "./policy.ts";
import { blockedBy, lintPrompt } from "./prompt.ts";

const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

/** params 里指向本地文件的参数（scene/cues/script…）：内容的哈希也要进输入，改文件才算改输入 */
/** 文本类输入：内容哈希；媒体类输入：小文件同样算内容，大文件退回「大小+修改时间」 */
const TEXT_INPUT = /\.(ya?ml|json|md|txt|srt)$/i;
const MEDIA_INPUT = /\.(mp4|mov|mkv|webm|wav|mp3|flac|m4a|aac|png|jpe?g|webp)$/i;
const FULL_HASH_LIMIT = 64 * 1024 * 1024;

export function hashReferencedFiles(projectDir: string, params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;
    const isText = TEXT_INPUT.test(value);
    const isMedia = MEDIA_INPUT.test(value);
    // 《最后一单》的 scene.yaml 改了要重出，舆图录制的 mp4 换了也一样——
    // 素材被同名文件替换却不判过期，是账本里最难发现的错
    if (!isText && !isMedia) continue;
    const path = resolve(projectDir, value);
    if (!existsSync(path)) continue;
    try {
      const stat = statSync(path);
      out[key] =
        isText || stat.size <= FULL_HASH_LIMIT
          ? sha256(readFileSync(path))
          : sha256(`${stat.size}:${stat.mtimeMs}`);
    } catch {}
  }
  return out;
}

/** 只影响混音、不影响产物的参数：改它们不该让素材过期 */
const MIX_ONLY_KEYS = new Set(["volume", "fadeIn", "fadeOut", "startFrame", "fit", "cues", "tolerance"]);

function stripMixParams(params: Record<string, string | number | boolean>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) if (!MIX_ONLY_KEYS.has(k)) out[k] = v;
  return out;
}

export function inputsHash(
  shot: ShotState,
  fps: number,
  params: Record<string, string | number | boolean> = shot.binder.params,
  modality: "image" | "video" | null = null,
  includeDuration = modality !== "image",
  extras: Record<string, string> = {},
  includeMixParams = false,
): string {
  // 只哈希"实际生效"的 prompt：改了通用兜底但专用 prompt 已存在时，不该判过期
  return sha256(
    Buffer.from(
      canonical({
        id: shot.id,
        // 图片的时长只是"放多久"，不参与生成；改时长不该让静帧过期
        durationFrames: includeDuration ? shot.durationFrames : 0,
        intent: {
          description: shot.intent.description,
          action: shot.intent.action,
          // 只有真正有旁白的 voice 镜头才加这个字段：画面镜头的哈希保持原样
          ...(shot.role === "voice" && shot.intent.narration ? { narration: shot.intent.narration } : {}),
          prompt: promptFor(shot.intent, modality),
        },
        // binder 里也带 params：这里必须用同一份"去掉混音参数"的副本，
        // 否则改 volume/fadeIn 会从 binder 这条缝里漏进哈希，把产物误判成过期
        binder: {
          provider: shot.binder.provider,
          task: shot.binder.task,
          params: includeMixParams ? params : stripMixParams(params),
        },
        params: includeMixParams ? params : stripMixParams(params),
        subjects: shot.subjects,
        references: shot.references,
        // 只有真的引用了本地文件才加这个字段：老作业的哈希里没有它
        ...(Object.keys(extras).length ? { files: extras } : {}),
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
  /** 人工确认：跳过 agent 渠道策略 */
  approve?: boolean;
}

export interface SubmitResult {
  jobId: string;
  phase: "requested" | "rejected";
  estimate: { amount: number; currency: string; units: string; priceUnknown: boolean };
  reason?: string;
  /** 已存在同输入的在途作业，直接复用，不重复排队 */
  reused?: boolean;
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
  const blockers = blockedBy(lintPrompt(shot, provider));
  if (blockers.length > 0) {
    throw new ValidationError(
      `${shot.id} 无法提交：\n${blockers.map((b) => `  - ${b.detail}`).join("\n")}`,
    );
  }

  const params = { ...shot.binder.params, ...(input.params ?? {}) };
  const estimate = provider.estimate({ shot, format: state.project.format });

  const actorKind = input.actor?.kind ?? "system";
  if ((actorKind === "agent" || actorKind === "mcp") && !input.approve) {
    const violation = policyViolation(readPolicy(service.dir), provider, estimate);
    if (violation) throw new ValidationError(`${shot.id} 被渠道策略拦下：${violation}`);
  }
  const hash = inputsHash(
    shot,
    state.project.format.fps,
    params,
    provider.modality ?? null,
    undefined,
    hashReferencedFiles(service.dir, params),
  );

  const pendingSame = [...state.jobs.values()].find(
    (j) => j.shot === shot.id && j.phase === "requested" && j.inputsHash === hash,
  );
  if (pendingSame && !input.opid) {
    return { jobId: pendingSame.jobId, phase: "requested", estimate: pendingSame.estimate, reused: true };
  }

  const jobId = `job-${shot.id}-${state.jobs.size + 1}`;

  // 先记录请求：被预算拒绝的作业也必须留在队列历史里，否则"为什么没生成"查不到
  service.append(
    "job.requested",
    {
      jobId,
      shot: shot.id,
      provider: provider.id,
      task: shot.binder.task,
      modality: provider.modality ?? null,
      params,
      estimate,
      inputsHash: hash,
      inputsVersion: 2,
    },
    { actor: input.actor, opid: input.opid },
  );

  if (!estimate.priceUnknown && state.project.budget) {
    const remaining = remainingBudget(state) ?? 0;
    if (estimate.amount > remaining) {
      const reason = `超出剩余预算：需要 ${estimate.amount.toFixed(2)} ${estimate.currency}，剩余 ${remaining.toFixed(2)} ${estimate.currency}`;
      service.append("job.rejected", { jobId, reason, cause: "budget" }, { actor: input.actor });
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

/**
 * 引擎/CLI 启动时清理孤立作业：进程崩溃后 job.started 的事件会留在 running，
 * 它既不会自己完成，也不该被当成"正在跑"。标记失败，让用户知道要去 provider 侧确认花费。
 */
export function reconcileOrphans(service: Service): number {
  const orphaned = [...service.state().jobs.values()].filter((j) => j.phase === "running");
  for (const job of orphaned) {
    service.append("job.failed", {
      jobId: job.jobId,
      reason: "进程中断：作业停在 running 状态，可能已产生费用，请到 provider 侧确认",
    });
  }
  return orphaned.length;
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
    // 预算是"花之前"的闸门：排队期间别的作业可能已经花掉余额，所以执行前重新核对一次
    const live = service.state();
    if (live.project?.budget && !job.estimate.priceUnknown) {
      const remaining = (remainingBudget(live) ?? 0) + job.estimate.amount;
      if (job.estimate.amount > remaining) {
        const reason = `执行前预算不足：需要 ${job.estimate.amount.toFixed(2)} ${job.estimate.currency}，剩余 ${remaining.toFixed(2)}`;
        service.append("job.rejected", { jobId: job.jobId, reason, cause: "budget" });
        outcomes.push({ jobId: job.jobId, shot: job.shot, ok: false, reason });
        continue;
      }
    }

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

    const logLines: string[] = [];
    const onLog = (line: string) => {
      for (const part of String(line).split("\n")) {
        if (!part.trim()) continue;
        logLines.push(part);
        if (logLines.length > 400) logLines.shift();
      }
      options.onLog?.(line);
    };

    service.append("job.started", { jobId: job.jobId });
    const timeoutMs = Number(process.env.FILMBENCH_JOB_TIMEOUT_MS ?? 20 * 60 * 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const references: Record<string, string> = {};
      for (const ref of shot.references) {
        const asset = state.assets.get(ref.asset);
        if (asset) references[ref.asset] = join(service.dir, asset.path);
      }
      const result: ProviderRunResult = await provider.run({
        jobId: job.jobId,
        shot,
        params: job.params,
        projectDir: service.dir,
        format: state.project.format,
        references,
        signal: controller.signal,
        onLog,
      });
      if (!result.files.length) throw new Error("provider 没有产出任何文件");

      const main = result.files[0];
      if (!existsSync(main.path)) throw new Error(`产物不存在: ${main.path}`);
      if (logLines.length) service.append("job.log", { jobId: job.jobId, lines: logLines.slice(-400) });
      const stored = await materialize(service, { path: main.path, mime: main.mime }, job.jobId, provider.id);
      const bytes = stored.bytes;

      // 用当前镜头状态重算输入哈希：provider 实际读到的就是这一份
      const runtimeHash = inputsHash(
        shot,
        state.project.format.fps,
        job.params,
        provider.modality ?? null,
        undefined,
        hashReferencedFiles(service.dir, job.params),
      );
      service.append("job.completed", {
        jobId: job.jobId,
        inputsHash: runtimeHash,
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
      const aborted = controller.signal.aborted;
      const reason = aborted
        ? `超时：超过 ${Math.round(timeoutMs / 1000)}s 未完成，已终止子进程（产物可能不完整）`
        : (err as Error).message;
      if (logLines.length) service.append("job.log", { jobId: job.jobId, lines: logLines.slice(-400) });
      service.append("job.failed", { jobId: job.jobId, reason });
      outcomes.push({ jobId: job.jobId, shot: job.shot, ok: false, reason });
    } finally {
      clearTimeout(timer);
    }
  }

  return outcomes;
}

/**
 * 修正作业记录的输入哈希：产物确实是用当前输入做出来的，但记录写的是旧值。
 * 只允许带理由调用（落进事件日志），过期判定不会因此被"关掉"——下一次改输入照样会过期。
 */
export function rehashJob(
  service: Service,
  registry: ProviderRegistry,
  jobId: string,
  reason: string,
  actor: Actor,
): { jobId: string; inputsHash: string } {
  const state = service.state();
  const job = state.jobs.get(jobId);
  if (!job) throw new ValidationError(`作业不存在: ${jobId}`);
  if (!job.produce) throw new ValidationError(`${jobId} 还没有产物，没有可修正的哈希`);
  const shot = state.shots.find((s) => s.id === job.shot);
  if (!shot) throw new ValidationError(`镜头不存在: ${job.shot}`);
  const provider = requireProvider(registry, shot.binder.provider);
  const hash = inputsHash(
    shot,
    state.project.format.fps,
    job.params,
    provider.modality ?? null,
    undefined,
    hashReferencedFiles(service.dir, job.params),
  );
  if (hash === job.inputsHash) return { jobId, inputsHash: hash };
  service.append("job.rehashed", { jobId, inputsHash: hash, reason }, { actor });
  return { jobId, inputsHash: hash };
}

/**
 * 收下远端已经产出的文件：长作业在连接断开、CLI 被杀之后，产物还在远端，
 * 不该为了"记一笔账"再花一次钱。仍然按运行时输入重算哈希、仍然走内容寻址。
 */
export async function collectJob(
  service: Service,
  registry: ProviderRegistry,
  jobId: string,
  file: string,
  reason: string,
  actor: Actor,
): Promise<RunOutcome> {
  const state = service.state();
  const job = state.jobs.get(jobId);
  if (!job) throw new ValidationError(`作业不存在: ${jobId}`);
  if (job.phase === "done") throw new ValidationError(`${jobId} 已经完成，不需要再收一次`);
  const shot = state.shots.find((s) => s.id === job.shot);
  if (!shot) throw new ValidationError(`镜头不存在: ${job.shot}`);
  if (!existsSync(file)) throw new ValidationError(`文件不存在: ${file}`);
  const provider = requireProvider(registry, shot.binder.provider);

  const probe = Bun.spawnSync([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_frames,avg_frame_rate",
    "-of", "json", file,
  ]);
  let width = 0, height = 0, frames = 0;
  try {
    const info = JSON.parse(probe.stdout.toString());
    const s = info.streams?.[0];
    width = Number(s?.width ?? 0);
    height = Number(s?.height ?? 0);
    const [n, d] = String(s?.avg_frame_rate ?? "0/1").split("/").map(Number);
    frames = Number(s?.nb_frames) || 0;
    if (!frames && d) {
      const dur = Number(
        Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
          .stdout.toString().trim(),
      );
      frames = Number.isFinite(dur) ? Math.round(dur * (n / d)) : 0;
    }
  } catch {}

  const stored = await materialize(service, { path: file, mime: "video/mp4" }, jobId, provider.id);
  const runtimeHash = inputsHash(
    shot,
    state.project.format.fps,
    job.params,
    provider.modality ?? null,
    undefined,
    hashReferencedFiles(service.dir, job.params),
  );
  service.append("job.completed", {
    jobId,
    inputsHash: runtimeHash,
    kind: "video",
    asset: stored.asset,
    sha256: stored.digest,
    bytes: stored.bytes,
    width,
    height,
    durationFrames: frames || shot.durationFrames,
    mime: "video/mp4",
    path: stored.path,
  }, { actor });
  service.append("job.log", { jobId, lines: [`collected from ${file}：${reason}`] });
  return { jobId, shot: shot.id, ok: true, asset: stored.asset, path: stored.path };
}
