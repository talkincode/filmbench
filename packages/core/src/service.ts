import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  canonical,
  type EventOp,
  type Film,
  type Shot,
  type ShotPatch,
  type SubjectPin,
  assertFilm,
} from "@filmbench/protocol";
import { Journal, type StoredEvent } from "./journal.ts";
import { Index } from "./db.ts";
import { fold, mergeShotPatch, type ProjectState } from "./state.ts";

export class ConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`基础修订不匹配：期望 ${expected}，当前 ${actual}`);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface Actor {
  kind: "human" | "agent" | "mcp" | "system";
  id: string;
}

export interface AppendOptions {
  actor?: Actor;
  opid?: string;
  base?: number;
  ref?: string;
}

export interface AppendResult {
  event: StoredEvent;
  replayed: boolean;
}

const SYSTEM: Actor = { kind: "system", id: "engine" };

/** 项目目录布局：journal 是真相，其余都是投影 */
export const PATHS = {
  journal: "journal",
  assets: "assets",
  build: "build",
  db: ".filmbench/index.db",
  film: "film.yaml",
} as const;

/**
 * 唯一写入路径：GUI（IPC）、CLI、MCP、内置 agent 都走这里。
 * 每次写入都要过三道闸：载荷 schema、baseRevision 比对、operationId 幂等。
 */
export class Service {
  private constructor(
    readonly dir: string,
    readonly journal: Journal,
    readonly index: Index,
  ) {}

  static open(dir: string): Service {
    mkdirSync(join(dir, PATHS.assets), { recursive: true });
    mkdirSync(join(dir, PATHS.build), { recursive: true });
    const journal = new Journal(join(dir, PATHS.journal));
    const index = new Index(join(dir, PATHS.db));
    const service = new Service(dir, journal, index);
    if (index.db.query(`select count(*) as n from events`).get<{ n: number }>()!.n === 0) {
      service.reindex();
    }
    return service;
  }

  head(ref = "main"): { seq: number; hash: string } {
    return this.journal.head(ref);
  }

  state(ref = "main"): ProjectState {
    return fold(this.journal.events(), ref, this.head(ref), this.dir);
  }

  append(op: EventOp, payload: unknown, options: AppendOptions = {}): AppendResult {
    const actor = options.actor ?? SYSTEM;
    const opid = options.opid ?? randomUUID();
    const ref = options.ref ?? "main";

    const seen = this.index.findOp(opid);
    if (seen !== undefined) {
      const existing = this.journal.events().find((e) => e.seq === seen);
      if (existing) return { event: existing, replayed: true };
    }

    const head = this.head(ref);
    if (options.base !== undefined && options.base !== head.seq) {
      throw new ConflictError(options.base, head.seq);
    }

    const event = this.journal.append({ op, payload, actor, opid, ref, base: options.base });
    this.index.apply(event);
    return { event, replayed: false };
  }

  verify(): { ok: boolean; problems: string[] } {
    const chain = this.journal.verify();
    return chain;
  }

  /** 索引可删可重建：删库重放后必须与事件日志一致 */
  reindex(): { events: number } {
    const events = this.journal.events();
    this.index.rebuild(events);
    return { events: events.length };
  }

  exportFilm(ref = "main"): Film {
    const state = this.state(ref);
    if (!state.project) throw new ValidationError("项目尚未创建");
    const film = {
      apiVersion: "filmbench/v1",
      kind: "Film",
      metadata: { name: state.project.name, title: state.project.title },
      format: state.project.format,
      budget: state.project.budget,
      shots: state.shots.map((s) => ({
        id: s.id,
        title: s.title,
        role: s.role ?? "picture",
        durationFrames: s.durationFrames,
        intent: {
          description: s.intent.description,
          action: s.intent.action,
          prompt: s.intent.prompt,
          prompts: s.intent.prompts ?? { image: "", video: "" },
        },
        binder: s.binder,
        subjects: s.subjects,
        references: s.references,
        dependsOn: s.dependsOn,
      })),
    };
    return assertFilm(film);
  }

  close(): void {
    this.index.close();
  }

  /* —— 领域操作：每个都是一个事件，没有例外 —— */

  createProject(input: { name: string; title: string; format: Film["format"]; budget?: Film["budget"] }, options?: AppendOptions) {
    if (this.state().project) throw new ValidationError("项目已存在");
    return this.append("project.created", input, options);
  }

  addShot(shot: Shot, options?: AppendOptions) {
    const state = this.state();
    if (!state.project) throw new ValidationError("先创建项目");
    if (state.shots.some((s) => s.id === shot.id)) throw new ValidationError(`镜头已存在: ${shot.id}`);
    return this.append("shot.added", { shot }, options);
  }

  patchShot(id: string, patch: ShotPatch, options?: AppendOptions) {
    const state = this.state();
    const shot = state.shots.find((s) => s.id === id);
    if (!shot) throw new ValidationError(`镜头不存在: ${id}`);
    // 无变化就不写事件：避免"重写同样的 prompt"产生噪音（过期判定已改为输入哈希，双保险）
    const view = (s: typeof shot) =>
      canonical({
        id: s.id,
        title: s.title,
        durationFrames: s.durationFrames,
        intent: s.intent,
        binder: s.binder,
        subjects: s.subjects,
        references: s.references,
        dependsOn: s.dependsOn,
      });
    if (view(mergeShotPatch(shot, patch)) === view(shot)) {
      const last = this.journal.events().at(-1);
      if (last) return { event: last, replayed: true };
    }
    return this.append("shot.patched", { id, patch }, options);
  }

  moveShot(id: string, anchor: { before?: string; after?: string }, options?: AppendOptions) {
    const state = this.state();
    if (!state.shots.some((s) => s.id === id)) throw new ValidationError(`镜头不存在: ${id}`);
    const other = anchor.before ?? anchor.after;
    if (!other || !state.shots.some((s) => s.id === other)) throw new ValidationError(`锚点镜头不存在: ${other}`);
    if (other === id) throw new ValidationError("不能相对自己移动");
    return this.append("shot.moved", { id, ...anchor }, options);
  }

  removeShot(id: string, options?: AppendOptions) {
    const state = this.state();
    const used = state.shots.some((s) => s.dependsOn.some((d) => d.shot === id));
    if (used) throw new ValidationError(`镜头 ${id} 仍被其他镜头依赖`);
    return this.append("shot.removed", { id }, options);
  }

  registerAsset(
    input: { asset: string; sha256: string; bytes: number; mime: string; path: string; lineage?: { provider: string; task: string; jobId?: string } },
    options?: AppendOptions,
  ) {
    return this.append("asset.registered", input, options);
  }

  setScript(input: { title?: string; logline?: string; synopsis?: string; body?: string }, options?: AppendOptions) {
    return this.append("script.set", input, options);
  }

  setCover(shot: string, options?: AppendOptions) {
    const state = this.state();
    const target = state.shots.find((s) => s.id === shot);
    if (!target) throw new ValidationError(`镜头不存在: ${shot}`);
    if (!target.produce) throw new ValidationError(`${shot} 还没有产物，不能当封面`);
    return this.append("cover.set", { shot }, options);
  }

  setSelection(shot: string, kind: "video" | "image" | "audio", asset: string, options?: AppendOptions) {
    const state = this.state();
    if (!state.assets.has(asset)) throw new ValidationError(`素材未登记: ${asset}`);
    if (!state.shots.some((s) => s.id === shot)) throw new ValidationError(`镜头不存在: ${shot}`);
    return this.append("selection.set", { shot, kind, asset }, options);
  }

  proposeSubject(input: { id: string; name: string; revision: number; variant?: string }, options?: AppendOptions) {
    return this.append("subject.proposed", { ...input, approved: false }, options);
  }

  approveSubject(input: { id: string; revision: number; variant?: string }, options?: AppendOptions) {
    const sub = this.state().subjects.get(input.id);
    if (!sub) throw new ValidationError(`主体不存在: ${input.id}`);
    return this.append("subject.approved", input, options);
  }

  decideReview(shot: string, asset: string, decision: "approved" | "rejected", options?: AppendOptions) {
    return this.append("review.decided", { shot, asset, decision }, options);
  }

  pinSubject(shotId: string, pin: SubjectPin, options?: AppendOptions) {
    const shot = this.state().shots.find((s) => s.id === shotId);
    if (!shot) throw new ValidationError(`镜头不存在: ${shotId}`);
    const subjects = [...shot.subjects.filter((s) => s.id !== pin.id), pin];
    return this.patchShot(shotId, { subjects }, options);
  }
}
