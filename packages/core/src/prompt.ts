import { MAX_REFERENCES, promptFor, type Shot } from "@filmbench/protocol";
import type { Provider } from "./providers.ts";

export type PromptIssueStatus = "fail" | "warn" | "note";

export interface PromptIssue {
  id: string;
  status: PromptIssueStatus;
  detail: string;
}

/**
 * prompt 与参考图的规则检查。规则不是凭空定的，来自 vflow 参考制作规范里
 * 能机器判定的那几条：模态 prompt 必填、图内不要文字、参考图必须是明确的用途槽位、
 * 有主体就要有身份参考、参考数量不能超过目标工具能力。
 */
const TEXT_LEAK = /(字幕|编号|标注|标题|箭头|说明文字|水印|logo)/i;
const NO_TEXT = /(no text|no caption|no watermark|without text|无文字|不要文字|无字幕|不加字幕)/i;

export function lintPrompt(shot: Shot, provider: Provider | undefined): PromptIssue[] {
  const issues: PromptIssue[] = [];
  const modality = provider?.modality ?? null;
  const prompt = promptFor(shot.intent, modality).trim();
  const refs = shot.references ?? [];

  if (provider?.requiresPrompt && !prompt) {
    issues.push({
      id: "prompt.missing",
      status: "fail",
      detail: `缺少 ${modality === "video" ? "视频" : "图片"} prompt：在 intent.prompts.${modality ?? "prompt"} 里写清楚主体、动作、机位与光线`,
    });
  } else if (prompt) {
    if (prompt.length < 24) {
      issues.push({ id: "prompt.thin", status: "warn", detail: `prompt 只有 ${prompt.length} 字符，主体/动作/机位大概率没交代清` });
    }
    if (prompt.length > 900) {
      issues.push({ id: "prompt.long", status: "note", detail: `${prompt.length} 字符，模型注意力会摊薄；把不变的部分交给参考图` });
    }
    if (modality === "image" && TEXT_LEAK.test(prompt) && !NO_TEXT.test(prompt)) {
      issues.push({
        id: "prompt.text-leak",
        status: "warn",
        detail: "prompt 里出现了文字类词（字幕/编号/标注…）但没有明确「不要文字」，图里很可能生成伪文字",
      });
    }
  }

  if (provider?.maxReferences !== undefined && refs.length > provider.maxReferences) {
    issues.push({
      id: "reference.limit",
      status: "fail",
      detail: `${refs.length} 张参考图，${provider.id} 上限 ${provider.maxReferences}`,
    });
  }
  if (refs.length > MAX_REFERENCES) {
    issues.push({ id: "reference.limit", status: "fail", detail: `${refs.length} 张参考图，协议上限 ${MAX_REFERENCES}` });
  }
  if (refs.length > 0 && refs.every((r) => r.role === "other")) {
    issues.push({
      id: "reference.roles",
      status: "warn",
      detail: "所有参考图都是 other：身份/服装/环境/首帧这些槽位要分开，否则模型不知道哪张管什么",
    });
  }
  if ((shot.subjects ?? []).length > 0 && refs.length > 0 && !refs.some((r) => r.role === "identity")) {
    issues.push({
      id: "reference.identity",
      status: "warn",
      detail: "绑定了主体却没有 identity 参考图：角色长相只能靠 prompt 猜",
    });
  }

  return issues;
}

/** 提交作业前必须满足的条件：不满足直接拒绝，不浪费一次付费调用 */
export function blockedBy(issues: PromptIssue[]): PromptIssue[] {
  return issues.filter((i) => i.status === "fail");
}
