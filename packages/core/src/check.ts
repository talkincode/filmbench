import type { ProviderRegistry } from "./providers.ts";
import { projectStoryboard } from "./storyboard.ts";
import { compile } from "./compile.ts";
import { lintPrompt } from "./prompt.ts";
import { shotStale } from "./stale.ts";
import { totalFrames } from "./state.ts";
import type { Service } from "./service.ts";

export interface CheckItem {
  id: string;
  ok: boolean;
  /** 不通过是否阻断出片 */
  blocking: boolean;
  detail: string;
}

export interface CheckReport {
  ok: boolean;
  items: CheckItem[];
  frames: number;
  shots: number;
}

/**
 * 一键验收：把"能不能出片"拆成可判定的条目。
 * 出片/审片前跑一遍，人看一张表，机器看 exit code。
 */
export function runChecks(service: Service, registry: ProviderRegistry): CheckReport {
  const state = service.state();
  const items: CheckItem[] = [];
  const add = (id: string, ok: boolean, detail: string, blocking = true) => items.push({ id, ok, blocking, detail });

  const chain = service.verify();
  add("事件链完整", chain.ok, chain.ok ? `${state.head.seq} 条事件` : chain.problems.join("; "));

  if (!state.project) {
    add("项目已创建", false, "没有 project.created 事件");
    return { ok: false, items, frames: 0, shots: 0 };
  }
  add("项目已创建", true, `${state.project.name} · ${state.project.format.width}×${state.project.format.height}@${state.project.format.fps}`);

  const body = state.script?.body?.trim() ?? "";
  add(
    "剧本",
    Boolean(body),
    body ? `已写 ${body.length} 字${state.script?.logline ? ` · ${state.script.logline}` : ""}` : "还没写剧本（filmbench script set --file）",
    false,
  );

  const missing = state.shots.filter((s) => !s.produce).map((s) => s.id);
  add("每镜有产物", missing.length === 0, missing.length ? `缺 ${missing.join(", ")}` : `${state.shots.length} 镜全部有产物`);

  const stale = state.shots.filter((s) => s.produce && shotStale(state, s)).map((s) => s.id);
  add("产物不过期", stale.length === 0, stale.length ? `过期 ${stale.join(", ")}` : "输入与产物一致");

  const unselected = state.shots.filter((s) => {
    const sel = state.selections.get(s.id);
    const asset = sel?.video ?? sel?.image ?? sel?.audio;
    return !asset || !s.produce || asset !== s.produce.asset;
  }).map((s) => s.id);
  add("已选定", unselected.length === 0, unselected.length ? `未选定 ${unselected.join(", ")}` : "每镜都选定了当前产物");

  const unapproved = state.shots.filter((s) => {
    const sel = state.selections.get(s.id);
    const asset = sel?.video ?? sel?.image ?? sel?.audio;
    return !asset || state.reviews.get(`${s.id}:${asset}`) !== "approved";
  }).map((s) => s.id);
  add("已审阅批准", unapproved.length === 0, unapproved.length ? `未批准 ${unapproved.join(", ")}` : "每镜的选定都已批准");

  const promptFails = state.shots.flatMap((s) =>
    lintPrompt(s, registry.get(s.binder.provider))
      .filter((i) => i.status === "fail")
      .map((i) => `${s.id}: ${i.id}`),
  );
  add("提示词规则", promptFails.length === 0, promptFails.length ? promptFails.join("; ") : "没有阻断级问题");

  const { ir, issues } = compile(state, service.dir);
  add("可编译", Boolean(ir), ir ? `${ir.clips.length} 段 · ${ir.totalFrames} 帧` : issues.map((i) => `${i.shot ?? "-"} ${i.code}`).join("; "));

  const projection = projectStoryboard(service, registry);
  const blockers = projection.shots.flatMap((s) => (s.checks ?? []).filter((c) => c.status === "fail").map(() => s.id));
  add("审计无阻塞", blockers.length === 0, blockers.length ? `阻塞 ${[...new Set(blockers)].join(", ")}` : "0 项阻断");

  const cost = state.ledger.filter((r) => !r.priceUnknown);
  const spent = cost.reduce((n, r) => n + r.amount, 0);
  const limit = state.project.budget?.limit;
  add(
    "预算",
    limit === undefined || spent <= limit,
    limit === undefined ? `未设预算 · 已花 ${spent.toFixed(2)}` : `已花 ${spent.toFixed(2)} / ${limit.toFixed(2)}`,
    false,
  );

  add("封面", Boolean(state.cover), state.cover ? `封面取自 ${state.cover.shot}` : "还没设置封面（filmbench cover --shot <id>）", false);

  return { ok: items.every((i) => i.ok || !i.blocking), items, frames: totalFrames(state), shots: state.shots.length };
}
