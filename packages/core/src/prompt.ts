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
const TEXT_LEAK = /(字幕|编号|标注|标题|箭头|说明文字|水印|logo|匾额|旗号|木牌|刻字|碑文|告示)/i;
/** 视频里"文字"最容易从旗幡、木牌、墙面刻字里冒出来——这条专门盯它 */
const SIGNAGE = /(旗|幡|匾|牌|碑|门额|刻字|题字|楹联|告示|榜文)/;
/** 写了"旗幡/木牌"但同时声明了素面/无字，就不算漏写——判定交给 NO_TEXT */

/** 背景是否被交代了"自己的运动"：没有这层，成片就是前景动、背景像贴图 */
const BG_MOTION =
  /(河面|水面|水纹|波纹|浪|雾|云|火星|烟|尘埃|尘土|雨|旗(帜|幡)?|树叶|芦苇|光线|天光|远处.{0,6}(动|流|飘|移)|背景.{0,8}(动|流|飘|移))/;
const FG_LAYER = /(前景|中景|远景|背景|虚焦)/;

/** 画面里有"人"时，必须给出人自己的动作——否则 H3 会让人物定格，只有火/雾在动 */
const SUBJECT = /(人|役夫|工匠|士卒|挑夫|队伍|百姓|孩子|老翁|女子|男子)/;
const SUBJECT_MOTION =
  /(走|挑|抬|扛|搬|弯|蹲|转身|回头|迈步|停下|跑|拉|推|挥|举|俯身|直起身|穿过|走进|走出|递|接过|攀|踏)/;

/** 动作类动词：判"物理关系"有没有写全 */
const TOOL_ACTION = /(凿|锤|撬|推|拉|抡|敲|钉|锯|抬|扛|劈)/;
const CONTACT = /(抵|触|嵌|贴|插|入|落在|压|顶住|接触|打进|钉入)/;
const NO_TEXT =
  /(no text|no caption|no watermark|without text|无文字|不要文字|没有文字|没有任何文字|不要出现任何文字|不含文字|无字|素布|空白|无字幕|不加字幕|没有水印|无水印)/i;

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

    if (modality === "video") {
      // 旗幡/木牌/刻字是 AI 视频里伪汉字的主要来源：没说"不要文字"，几乎必出
      if (SIGNAGE.test(prompt) && !NO_TEXT.test(prompt)) {
        issues.push({
          id: "prompt.signage-leak",
          status: "warn",
          detail: "镜头里有旗幡/木牌/刻字一类物件，但没有写「画面中不要出现任何文字」——大概率会出现伪汉字",
        });
      }
      // 背景不写运动，模型就把它当静态贴图：前景在演、背景像图层拼合
      if (!BG_MOTION.test(prompt)) {
        issues.push({
          id: "prompt.static-background",
          status: "warn",
          detail: "没有交代背景（河面/雾/云/火星…）自己的运动：成片容易像「前景在动、背景是贴图」",
        });
      }
      // 有工具动作却不写接触关系，物理经常错（凿子插进石头、木槌砸到手）
      if (TOOL_ACTION.test(prompt) && !CONTACT.test(prompt)) {
        issues.push({
          id: "prompt.physics",
          status: "warn",
          detail: "写了工具动作但没有写接触关系（抵住/嵌入/落在）：凿子插进石头、锤子砸到手这类错误就出在这里",
        });
      }
      // 有人却没有人的动作：成片里人就是静止的，只有火和雾在动（门洞那镜踩过）
      if (SUBJECT.test(prompt) && !SUBJECT_MOTION.test(prompt)) {
        issues.push({
          id: "prompt.static-subject",
          status: "warn",
          detail: "画面里有人，但没有写人自己的动作（走/挑/弯腰/转身…）：模型会让人物定格，只有环境在动",
        });
      }
      if (!FG_LAYER.test(prompt)) {
        issues.push({
          id: "prompt.layering",
          status: "note",
          detail: "没有分前景/中景/背景来写：分层描述是让模型产生纵深与视差的最便宜手段",
        });
      }
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
