import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * 工作流定义 filmbench/workflow/v1 —— 环境/参数/能力全部声明在文件里，
 * 脚本不许再写死默认值。改动 defaults 与 capabilities 都会进会话哈希。
 */
export const WORKFLOW = z.object({
  schema: z.literal("filmbench/workflow/v1"),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  gpu: z.enum(["T4", "L4", "G4", "A100", "H100"]),
  defaults: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      length: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      steps: z.number().int().positive().optional(),
      seed: z.number().int().optional(),
      refImageSize: z.enum(["match", "max"]).optional(),
    })
    .default({}),
  capabilities: z
    .object({
      firstFrame: z.boolean().default(false),
      lastFrame: z.boolean().default(false),
      referenceImages: z.boolean().default(false),
      referenceVideos: z.boolean().default(false),
      controlVideo: z.boolean().default(false),
    })
    .default({}),
  run: z.string().default("run.py"),
  setup: z.string().default("setup.py"),
  out: z.string().default("/content/filmbench/out/{jobId}.mp4"),
  /** 需要从 Comfy-Org/MiniMax-H3 取的文件（相对该仓库的路径） */
  models: z.array(z.string()).default([]),
  pips: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  notes: z.string().optional(),
});
export type WorkflowSpec = z.infer<typeof WORKFLOW>;

export function readWorkflowSpec(dir: string): WorkflowSpec {
  const path = join(dir, "workflow.json");
  if (!existsSync(path)) throw new Error(`缺少 ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON：${(e as Error).message}`);
  }
  const parsed = WORKFLOW.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${path} 不符合 filmbench/workflow/v1：${detail}`);
  }
  return parsed.data;
}

/** 校验岗位需求与工作流能力是否匹配：不支持的能力直接报错，不静默丢输入 */
export function assertCapabilities(
  spec: WorkflowSpec,
  need: { firstFrame?: boolean; lastFrame?: boolean; referenceImages?: boolean; referenceVideos?: boolean },
): void {
  const checks: [keyof typeof need, keyof WorkflowSpec["capabilities"], string][] = [
    ["firstFrame", "firstFrame", "首帧"],
    ["lastFrame", "lastFrame", "尾帧"],
    ["referenceImages", "referenceImages", "参考图"],
    ["referenceVideos", "referenceVideos", "参考视频"],
  ];
  for (const [needKey, capKey, label] of checks) {
    if (need[needKey] && !spec.capabilities[capKey]) {
      throw new Error(`工作流 ${spec.name} 不支持${label}，但镜头提供了；换工作流或去掉输入`);
    }
  }
}
