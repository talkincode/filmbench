import type { Binder, Format, Shot, ShotPatch, SubjectPin } from "@filmbench/protocol";
import type { StoredEvent } from "./journal.ts";

export interface AssetState {
  asset: string;
  sha256: string;
  bytes: number;
  mime: string;
  path: string;
  lineage?: { provider: string; task: string; jobId?: string };
  atSeq: number;
}

export interface ProduceState {
  kind: "video" | "image";
  asset: string;
  sha256: string;
  bytes: number;
  mime: string;
  path: string;
  width: number;
  height: number;
  durationFrames: number;
  jobId: string;
  atSeq: number;
}

export type JobPhase = "requested" | "running" | "done" | "failed" | "rejected";

export interface JobState {
  jobId: string;
  shot: string;
  provider: string;
  task: string;
  params: Record<string, string | number | boolean>;
  estimate: { amount: number; currency: string; units: string; priceUnknown: boolean };
  inputsHash: string;
  phase: JobPhase;
  reason?: string;
  rejectCause?: "budget" | "cancelled" | "other";
  log?: string[];
  produce?: ProduceState;
  requestedAt: number;
  updatedAt: number;
}

export interface SubjectState {
  id: string;
  name: string;
  revision: number;
  variant?: string;
  approved: boolean;
  atSeq: number;
}

export interface CostRow {
  seq: number;
  jobId?: string;
  kind: "api" | "compute" | "model" | "local";
  provider: string;
  units: string;
  unitPrice: number;
  amount: number;
  currency: string;
  priceUnknown: boolean;
}

export interface ShotState extends Shot {
  addedAt: number;
  mutatedAt: number;
  produce?: ProduceState;
}

export interface Selections {
  video?: string;
  image?: string;
  audio?: string;
}

export interface RenderState {
  out: string;
  sha256: string;
  bytes: number;
  durationFrames: number;
  atSeq: number;
}

export interface ProjectState {
  ref: string;
  head: { seq: number; hash: string };
  project?: { name: string; title: string; format: Format; budget?: { currency: string; limit: number } };
  shots: ShotState[];
  subjects: Map<string, SubjectState>;
  assets: Map<string, AssetState>;
  jobs: Map<string, JobState>;
  selections: Map<string, Selections>;
  reviews: Map<string, "approved" | "rejected">;
  ledger: CostRow[];
  renders: RenderState[];
  events: StoredEvent[];
}

const EMPTY: Omit<ProjectState, "ref" | "head" | "events"> = {
  shots: [],
  subjects: new Map(),
  assets: new Map(),
  jobs: new Map(),
  selections: new Map(),
  reviews: new Map(),
  ledger: [],
  renders: [],
};

export function mergeShotPatch(shot: Shot, patch: ShotPatch): Shot {
  const next: Shot = {
    ...shot,
    ...patch,
    intent: { ...shot.intent, ...(patch.intent ?? {}) },
    binder: patch.binder
      ? ({
          provider: patch.binder.provider ?? shot.binder.provider,
          task: patch.binder.task ?? shot.binder.task,
          params: { ...shot.binder.params, ...(patch.binder.params ?? {}) },
        } satisfies Binder)
      : shot.binder,
  };
  return next;
}

export function fold(events: StoredEvent[], ref = "main", head = { seq: 0, hash: "" }): ProjectState {
  const state: ProjectState = {
    ref,
    head,
    events: events.filter((e) => e.ref === ref),
    project: undefined,
    shots: [],
    subjects: new Map(EMPTY.subjects),
    assets: new Map(EMPTY.assets),
    jobs: new Map(EMPTY.jobs),
    selections: new Map(EMPTY.selections),
    reviews: new Map(EMPTY.reviews),
    ledger: [],
    renders: [],
  };

  for (const e of state.events) {
    const p = e.payload as any;
    switch (e.op) {
      case "project.created":
        state.project = { name: p.name, title: p.title, format: p.format, budget: p.budget };
        break;
      case "shot.added": {
        const shot = p.shot as Shot;
        state.shots.push({
          ...shot,
          intent: { ...shot.intent, prompts: shot.intent.prompts ?? { image: "", video: "" } },
          addedAt: e.seq,
          mutatedAt: e.seq,
        });
        break;
      }
      case "shot.patched": {
        const shot = state.shots.find((s) => s.id === p.id);
        if (!shot) break;
        Object.assign(shot, mergeShotPatch(shot, p.patch as ShotPatch), { mutatedAt: e.seq });
        break;
      }
      case "shot.removed":
        state.shots = state.shots.filter((s) => s.id !== p.id);
        break;
      case "asset.registered":
        state.assets.set(p.asset, {
          asset: p.asset,
          sha256: p.sha256,
          bytes: p.bytes,
          mime: p.mime,
          path: p.path,
          lineage: p.lineage,
          atSeq: e.seq,
        });
        break;
      case "selection.set": {
        const sel = state.selections.get(p.shot) ?? {};
        sel[p.kind as "video" | "image" | "audio"] = p.asset;
        state.selections.set(p.shot, sel);
        break;
      }
      case "subject.proposed":
      case "subject.approved": {
        const prev = state.subjects.get(p.id);
        state.subjects.set(p.id, {
          id: p.id,
          name: p.name ?? prev?.name ?? p.id,
          revision: p.revision,
          variant: p.variant,
          approved: e.op === "subject.approved" ? true : Boolean(p.approved),
          atSeq: e.seq,
        });
        break;
      }
      case "review.decided":
        state.reviews.set(`${p.shot}:${p.asset}`, p.decision);
        break;
      case "job.requested":
        state.jobs.set(p.jobId, {
          jobId: p.jobId,
          shot: p.shot,
          provider: p.provider,
          task: p.task,
          params: p.params,
          estimate: p.estimate,
          inputsHash: p.inputsHash,
          phase: "requested",
          requestedAt: e.seq,
          updatedAt: e.seq,
        });
        break;
      case "job.started": {
        const job = state.jobs.get(p.jobId);
        if (job) Object.assign(job, { phase: "running", updatedAt: e.seq });
        break;
      }
      case "job.completed": {
        const job = state.jobs.get(p.jobId);
        const produce: ProduceState = {
          kind: p.kind ?? "video",
          asset: p.asset,
          sha256: p.sha256,
          bytes: p.bytes,
          mime: p.mime,
          path: p.path,
          width: p.width,
          height: p.height,
          durationFrames: p.durationFrames,
          jobId: p.jobId,
          atSeq: e.seq,
        };
        if (job) Object.assign(job, { phase: "done", produce, updatedAt: e.seq });
        const shot = state.shots.find((s) => s.id === (job?.shot ?? ""));
        if (shot) shot.produce = produce;
        break;
      }
      case "job.failed":
      case "job.rejected": {
        const job = state.jobs.get(p.jobId);
        if (job) {
          Object.assign(job, {
            phase: e.op === "job.failed" ? "failed" : "rejected",
            reason: p.reason,
            rejectCause: e.op === "job.rejected" ? (p.cause ?? "other") : undefined,
            updatedAt: e.seq,
          });
        }
        break;
      }
      case "job.log": {
        const job = state.jobs.get(p.jobId);
        if (job) job.log = p.lines as string[];
        break;
      }
      case "cost.recorded":
        state.ledger.push({
          seq: e.seq,
          jobId: p.jobId,
          kind: p.kind,
          provider: p.provider,
          units: p.units,
          unitPrice: p.unitPrice,
          amount: p.amount,
          currency: p.currency,
          priceUnknown: p.priceUnknown,
        });
        break;
      case "render.completed":
        state.renders.push({
          out: p.out,
          sha256: p.sha256,
          bytes: p.bytes,
          durationFrames: p.durationFrames,
          atSeq: e.seq,
        });
        break;
      default:
        break;
    }
  }

  return state;
}

/* —— 派生查询：多个模块共用，避免各自解释一遍状态 —— */
export const totalFrames = (s: ProjectState) => s.shots.reduce((n, x) => n + x.durationFrames, 0);

export const spent = (s: ProjectState, currency?: string) =>
  Math.round(
    s.ledger
      .filter((r) => !r.priceUnknown && (currency ? r.currency === currency : true))
      .reduce((n, r) => n + r.amount, 0) * 1000,
  ) / 1000;

export const pendingEstimates = (s: ProjectState, currency?: string) =>
  Math.round(
    [...s.jobs.values()]
      .filter((j) => (j.phase === "requested" || j.phase === "running") && !j.estimate.priceUnknown)
      .filter((j) => (currency ? j.estimate.currency === currency : true))
      .reduce((n, j) => n + j.estimate.amount, 0) * 1000,
  ) / 1000;

export const remainingBudget = (s: ProjectState) => {
  if (!s.project?.budget) return null;
  const { currency, limit } = s.project.budget;
  return Math.round((limit - spent(s, currency) - pendingEstimates(s, currency)) * 1000) / 1000;
};

export const subjectApproved = (s: ProjectState, pin: SubjectPin): boolean => {
  const sub = s.subjects.get(pin.id);
  if (!sub) return false;
  return sub.approved && sub.revision === pin.revision && (pin.variant ? sub.variant === pin.variant : true);
};
