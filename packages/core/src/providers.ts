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
  params: Record<string, string | number | boolean>;
  projectDir: string;
  format: Format;
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
