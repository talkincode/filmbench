/**
 * filmbench 协议 v1 —— 单一命名空间，三种文档角色：
 *   Film    意图（人/agent 写：镜头、主体、依赖、预算）
 *   Event   历史（系统写：一切状态变更，append-only 哈希链）
 *   Ledger  账本（系统写：每一次付费调用的投影）
 *
 * 时间基只有一个：输出 fps 下的整数帧。
 */
import { z } from "zod";

/* —— 基础 —— */
export const ident = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "标识符：小写字母/数字/连字符");
export const providerId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/, "provider 标识：小写字母/数字/连字符，可用 / 分层");
export const ref = z.string().min(1);
export const sha = z.string().regex(/^[a-f0-9]{64}$/, "sha256 十六进制");
export const frames = z.number().int().nonnegative();
export const money = z.number().nonnegative();

export const FORMAT = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
});
export type Format = z.infer<typeof FORMAT>;

export const BUDGET = z.object({
  currency: z.string().length(3),
  limit: money,
});

/* —— Film：意图 —— */
export const SUBJECT_PIN = z.object({
  id: ident,
  revision: z.number().int().nonnegative(),
  variant: z.string().optional(),
});
export type SubjectPin = z.infer<typeof SUBJECT_PIN>;

export const BINDER = z.object({
  provider: providerId,
  task: ident,
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type Binder = z.infer<typeof BINDER>;

/** 参考图用途（来自 vflow 的教训：角色槽位不可互换） */
export const REFERENCE_ROLES = [
  "identity",
  "wardrobe",
  "prop",
  "environment",
  "layout",
  "first_frame",
  "last_frame",
  "style",
  "other",
] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

export const REFERENCE = z.object({
  asset: ident,
  role: z.enum(REFERENCE_ROLES).default("other"),
});

export const MAX_REFERENCES = 5;

export const DEPENDENCY = z.object({
  shot: ident,
  kind: z.enum(["continuity", "last_frame", "data", "derived"]),
});
export type Dependency = z.infer<typeof DEPENDENCY>;

export const SHOT = z.object({
  id: ident,
  title: z.string().min(1),
  /** picture 进画面，music/voice 只进音轨 */
  role: z.enum(["picture", "music", "voice"]).default("picture"),
  durationFrames: frames,
  intent: z.object({
    description: z.string().default(""),
    action: z.string().default(""),
    /** 旁白文本（role: voice 的镜头用） */
    narration: z.string().default(""),
    prompt: z.string().default(""),
    /** 按模态分开的模型 prompt：图生图 / 图生视频要的东西不是一回事 */
    prompts: z
      .object({
        image: z.string().default(""),
        video: z.string().default(""),
      })
      .default({ image: "", video: "" }),
  }),
  binder: BINDER,
  subjects: z.array(SUBJECT_PIN).default([]),
  references: z.array(REFERENCE).max(MAX_REFERENCES, "每个分镜最多 5 张参考图").default([]),
  dependsOn: z.array(DEPENDENCY).default([]),
});
export type Shot = z.infer<typeof SHOT>;

/**
 * 局部更新载荷。不能复用 SHOT.partial()：SHOT 里的 default() 会让缺失字段被补成空值，
 * 于是"只改标题"会顺手清空 prompt。
 */
export const SHOT_PATCH = z.object({
  title: z.string().min(1).optional(),
  role: z.enum(["picture", "music", "voice"]).optional(),
  durationFrames: frames.optional(),
  intent: z
    .object({
      description: z.string().optional(),
      action: z.string().optional(),
      narration: z.string().optional(),
      prompt: z.string().optional(),
      prompts: z
        .object({ image: z.string().optional(), video: z.string().optional() })
        .optional(),
    })
    .optional(),
  binder: z
    .object({
      provider: providerId.optional(),
      task: ident.optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .optional(),
  subjects: z.array(SUBJECT_PIN).optional(),
  references: z.array(REFERENCE).max(MAX_REFERENCES, "每个分镜最多 5 张参考图").optional(),
  dependsOn: z.array(DEPENDENCY).optional(),
});
export type ShotPatch = z.infer<typeof SHOT_PATCH>;

export const FILM = z.object({
  apiVersion: z.literal("filmbench/v1"),
  kind: z.literal("Film"),
  metadata: z.object({ name: ident, title: z.string() }),
  format: FORMAT,
  budget: BUDGET.optional(),
  shots: z.array(SHOT),
});
export type Film = z.infer<typeof FILM>;

/* —— Event：历史 —— */
export const EVENT_PAYLOADS = {
  "project.created": z.object({ name: ident, title: z.string(), format: FORMAT, budget: BUDGET.optional() }),
  "shot.added": z.object({ shot: SHOT }),
  "shot.patched": z.object({ id: ident, patch: SHOT_PATCH }),
  "shot.removed": z.object({ id: ident }),
  "shot.moved": z
    .object({ id: ident, before: ident.optional(), after: ident.optional() })
    .refine((v) => Boolean(v.before) !== Boolean(v.after), { message: "before / after 二选一" }),
  "script.set": z.object({
    title: z.string().optional(),
    logline: z.string().optional(),
    synopsis: z.string().optional(),
    body: z.string().optional(),
  }),
  "cover.set": z.object({ shot: ident }),
  "asset.registered": z.object({
    asset: ident,
    sha256: sha,
    bytes: z.number().int().nonnegative(),
    mime: z.string(),
    path: z.string(),
    lineage: z.object({ provider: providerId, task: ident, jobId: z.string().optional() }).optional(),
  }),
  "selection.set": z.object({ shot: ident, kind: z.enum(["video", "image", "audio"]), asset: ident }),
  "subject.proposed": z.object({
    id: ident,
    name: z.string(),
    revision: z.number().int().nonnegative(),
    variant: z.string().optional(),
    approved: z.literal(false),
  }),
  "subject.approved": z.object({
    id: ident,
    revision: z.number().int().nonnegative(),
    variant: z.string().optional(),
  }),
  "review.decided": z.object({
    shot: ident,
    asset: ident,
    decision: z.enum(["approved", "rejected"]),
  }),
  "job.requested": z.object({
    jobId: z.string(),
    shot: ident,
    provider: providerId,
    task: ident,
    /** provider 声明的模态；null 表示这个 provider 不消费 prompt（如纯色片段） */
    modality: z.enum(["image", "video"]).nullable().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    estimate: z.object({ amount: money, currency: z.string().length(3), units: z.string(), priceUnknown: z.boolean() }),
    inputsHash: sha,
    /** 输入哈希算法版本；老作业没有这个字段，按旧规则（时间戳）判过期 */
    inputsVersion: z.number().int().optional(),
  }),
  "job.started": z.object({ jobId: z.string() }),
  "job.completed": z.object({
    jobId: z.string(),
    /** 实际运行时算的输入哈希：提交后补的参考图不该把产物判成过期 */
    inputsHash: sha.optional(),
    kind: z.enum(["video", "image", "audio"]).default("video"),
    asset: ident,
    sha256: sha,
    bytes: z.number().int(),
    width: z.number().int().nonnegative().default(0),
    height: z.number().int().nonnegative().default(0),
    durationFrames: frames,
    mime: z.string(),
    path: z.string(),
  }),
  "job.failed": z.object({ jobId: z.string(), reason: z.string() }),
  "job.log": z.object({ jobId: z.string(), lines: z.array(z.string()).max(400) }),
  /**
   * 修正一条作业记录的输入哈希。只在"产物确实是用当前输入做出来的、但记录写的是旧哈希"时使用：
   * 必须带理由，落进事件日志，可审计——不是给"过期"开的后门。
   */
  "job.rehashed": z.object({ jobId: z.string(), inputsHash: sha, reason: z.string().min(8).max(400) }),
  "job.rejected": z.object({
    jobId: z.string(),
    reason: z.string(),
    cause: z.enum(["budget", "cancelled", "other"]).default("other"),
  }),
  "cost.recorded": z.object({
    jobId: z.string().optional(),
    kind: z.enum(["api", "compute", "model", "local"]),
    provider: providerId,
    units: z.string(),
    unitPrice: money,
    amount: money,
    currency: z.string().length(3),
    priceUnknown: z.boolean().default(false),
  }),
  "render.requested": z.object({ irHash: sha, out: z.string() }),
  "render.completed": z.object({
    out: z.string(),
    sha256: sha,
    bytes: z.number().int().nonnegative(),
    durationFrames: frames,
  }),
} as const;

export type EventOp = keyof typeof EVENT_PAYLOADS;
export const EVENT_OPS = Object.keys(EVENT_PAYLOADS) as EventOp[];

export const EVENT = z.object({
  apiVersion: z.literal("filmbench/v1"),
  kind: z.literal("Event"),
  seq: z.number().int().positive(),
  op: z.enum(EVENT_OPS as [EventOp, ...EventOp[]]),
  actor: z.object({
    kind: z.enum(["human", "agent", "mcp", "system"]),
    id: z.string().default("local"),
  }),
  at: z.string(),
  ref: z.string().default("main"),
  opid: z.string().min(1),
  base: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});
export type Event = z.infer<typeof EVENT>;

/** 载荷校验：op 与 payload 必须同时成立，未知 op 直接拒绝 */
export function parsePayload(op: EventOp, payload: unknown): unknown {
  const schema = EVENT_PAYLOADS[op] as z.ZodTypeAny | undefined;
  if (!schema) throw new Error(`未知事件 op: ${String(op)}`);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`事件 ${op} 的载荷不合法: ${detail}`);
  }
  return parsed.data;
}

/* —— 规范 JSON：哈希与 IR 都基于它，保证逐字节可复现 —— */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function assertFilm(input: unknown): Film {
  const parsed = FILM.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Film 不合法: ${detail}`);
  }
  const film = parsed.data;
  const ids = new Set<string>();
  for (const shot of film.shots) {
    if (ids.has(shot.id)) throw new Error(`Film 不合法: 镜头 id 重复 ${shot.id}`);
    ids.add(shot.id);
  }
  for (const shot of film.shots) {
    for (const dep of shot.dependsOn) {
      if (!ids.has(dep.shot)) throw new Error(`Film 不合法: ${shot.id} 依赖不存在的镜头 ${dep.shot}`);
      if (dep.shot === shot.id) throw new Error(`Film 不合法: ${shot.id} 依赖自己`);
    }
  }
  return film;
}

/** 解析某个模态实际要用的 prompt：专用字段优先，其次通用 prompt */
export function promptFor(intent: { prompt: string; prompts?: { image: string; video: string } }, modality: "image" | "video" | null): string {
  if (!modality) return intent.prompt;
  const specific = modality === "image" ? intent.prompts?.image : intent.prompts?.video;
  return (specific && specific.trim()) || intent.prompt;
}

/** 帧 → 秒：只在出图/出片边界使用，内部一律整数帧 */
export const seconds = (f: number, fps: number): number => Math.round((f / fps) * 1e6) / 1e6;
