import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./providers.ts";

/**
 * 渠道策略：限制 agent 能自己动用什么 provider。
 * 人（CLI/界面）可以直接跑；agent / MCP 走 submit 时必须过这一关。
 */
export interface Policy {
  allowedProviders: string[];
  allowVideo: boolean;
  allowUnknownPrice: boolean;
}

export const policyPath = (projectDir: string) => join(projectDir, ".filmbench", "policy.json");

export const DEFAULT_POLICY: Policy = {
  allowedProviders: ["filmbench/colorcard", "filmbench/title", "filmbench/scorekit", "imagine"],
  allowVideo: false,
  allowUnknownPrice: true,
};

export function readPolicy(projectDir: string): Policy {
  try {
    const raw = JSON.parse(readFileSync(policyPath(projectDir), "utf8")) as Partial<Policy>;
    return { ...DEFAULT_POLICY, ...raw };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function writePolicy(projectDir: string, policy: Policy): void {
  mkdirSync(join(projectDir, ".filmbench"), { recursive: true });
  writeFileSync(policyPath(projectDir), `${JSON.stringify(policy, null, 2)}\n`);
}

/** 返回拒绝原因；null 表示放行 */
export function policyViolation(
  policy: Policy,
  provider: Provider,
  estimate: { priceUnknown: boolean },
): string | null {
  if (!policy.allowedProviders.includes(provider.id)) {
    return `策略里的允许列表没有 ${provider.id}；需要人工改 .filmbench/policy.json`;
  }
  if (!policy.allowVideo && provider.modality === "video") {
    return `策略禁止自动使用视频渠道（${provider.id}）；人工确认后执行 filmbench jobs submit --shot <id> --approve`;
  }
  if (!policy.allowUnknownPrice && estimate.priceUnknown) {
    return `策略禁止自动使用价格未知的渠道（${provider.id}）；确认花费后加 --approve`;
  }
  return null;
}
