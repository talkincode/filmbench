import type { ProjectState } from "./state.ts";

export interface CostSummary {
  currency: string;
  spent: number;
  estimated: number;
  unknownPriceCalls: number;
  byProvider: { provider: string; calls: number; amount: number }[];
  byKind: { kind: string; calls: number; amount: number }[];
  byShot: { shot: string; amount: number; calls: number }[];
  budget: { limit: number; remaining: number; usedPct: number } | null;
}

/** 账本投影：花费按 provider / 计量类型 / 镜头三个维度聚合，未知价格单独计数。 */
export function summarize(state: ProjectState): CostSummary {
  const currency = state.project?.budget?.currency ?? state.ledger[0]?.currency ?? "USD";
  const rows = state.ledger.filter((r) => r.currency === currency);
  const paid = rows.filter((r) => !r.priceUnknown);
  const round = (n: number) => Math.round(n * 1000) / 1000;

  const byProvider = new Map<string, { calls: number; amount: number }>();
  for (const r of paid) {
    const cur = byProvider.get(r.provider) ?? { calls: 0, amount: 0 };
    cur.calls += 1;
    cur.amount += r.amount;
    byProvider.set(r.provider, cur);
  }

  const byKind = new Map<string, { calls: number; amount: number }>();
  for (const r of paid) {
    const cur = byKind.get(r.kind) ?? { calls: 0, amount: 0 };
    cur.calls += 1;
    cur.amount += r.amount;
    byKind.set(r.kind, cur);
  }

  const jobShot = new Map<string, string>();
  for (const job of state.jobs.values()) jobShot.set(job.jobId, job.shot);
  const byShot = new Map<string, { calls: number; amount: number }>();
  for (const r of paid) {
    const shot = r.jobId ? (jobShot.get(r.jobId) ?? "—") : "—";
    const cur = byShot.get(shot) ?? { calls: 0, amount: 0 };
    cur.calls += 1;
    cur.amount += r.amount;
    byShot.set(shot, cur);
  }

  const spent = round(paid.reduce((n, r) => n + r.amount, 0));
  const estimated = round(
    [...state.jobs.values()]
      .filter((j) => j.phase === "requested" && !j.estimate.priceUnknown)
      .reduce((n, j) => n + j.estimate.amount, 0),
  );
  const budget = state.project?.budget
    ? {
        limit: state.project.budget.limit,
        remaining: round(state.project.budget.limit - spent),
        usedPct: state.project.budget.limit > 0 ? Math.round((spent / state.project.budget.limit) * 100) : 0,
      }
    : null;

  return {
    currency,
    spent,
    estimated,
    unknownPriceCalls: rows.filter((r) => r.priceUnknown).length,
    byProvider: [...byProvider].map(([provider, v]) => ({ provider, calls: v.calls, amount: round(v.amount) })),
    byKind: [...byKind].map(([kind, v]) => ({ kind, calls: v.calls, amount: round(v.amount) })),
    byShot: [...byShot]
      .map(([shot, v]) => ({ shot, calls: v.calls, amount: round(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
    budget,
  };
}
