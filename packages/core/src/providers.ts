import type { Format, Shot } from "@filmbench/protocol";

export interface ProviderEstimate {
  amount: number;
  currency: string;
  units: string;
  priceUnknown: boolean;
}

export interface ProviderFile {
  kind: "video" | "image";
  /** 绝对路径；落库前会被内容寻址复制到 assets/<sha>/ */
  path: string;
  mime: string;
  width: number;
  height: number;
  durationFrames: number;
}

export interface ProviderRunInput {
  shot: Shot;
  /** 作业 id：远程会话要按它命名产物 */
  jobId?: string;
  /** 超时/取消时由执行器触发；provider 必须杀掉自己起的子进程 */
  signal?: AbortSignal;
  params: Record<string, string | number | boolean>;
  projectDir: string;
  format: Format;
  /** 镜头参考图 → 项目内绝对路径；由执行器解析，provider 不碰存储 */
  references?: Record<string, string>;
  onLog?: (line: string) => void;
}

export interface ProviderRunResult {
  files: ProviderFile[];
  cost?: {
    kind: "api" | "compute" | "model" | "local";
    units: string;
    unitPrice: number;
    amount: number;
    currency: string;
  };
  priceUnknown?: boolean;
}

/**
 * provider 契约。确定性等级决定"要不要再花一次钱"：
 * deterministic 可永久缓存；seeded 记录 seed；nondeterministic 必须显式复用。
 */
export interface Provider {
  id: string;
  tasks: string[];
  determinism: "deterministic" | "seeded" | "nondeterministic";
  /** 该 provider 单次调用能吃下的参考图上限 */
  maxReferences?: number;
  /** 该 provider 产出什么模态：决定用哪条 prompt，也决定尺寸校验的严格度 */
  modality?: "image" | "video";
  /** 提交前是否必须有 prompt（纯本地产线卡不需要） */
  requiresPrompt?: boolean;
  estimate(input: { shot: Shot; format: Format }): ProviderEstimate;
  health(): { ok: boolean; detail: string };
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
}

export type ProviderRegistry = Map<string, Provider>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function requireProvider(registry: ProviderRegistry, id: string): Provider {
  const provider = registry.get(id);
  if (!provider) throw new ProviderError(`未注册的 provider: ${id}`, id);
  return provider;
}
