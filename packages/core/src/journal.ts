import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonical, parsePayload, type EventOp } from "@filmbench/protocol";

export const ZERO_HASH = "0".repeat(64);

export interface StoredEvent {
  seq: number;
  hash: string;
  prev: string;
  ref: string;
  op: EventOp;
  actor: { kind: "human" | "agent" | "mcp" | "system"; id: string };
  at: string;
  opid: string;
  base?: number;
  payload: unknown;
}

export interface AppendInput {
  op: EventOp;
  payload: unknown;
  actor: StoredEvent["actor"];
  opid: string;
  ref?: string;
  base?: number;
  at?: string;
}

const hashOf = (prev: string, body: unknown) =>
  createHash("sha256").update(`${prev}\n${canonical(body)}`).digest("hex");

/**
 * 事件日志。真相在这里：每个事件一个文件，哈希链引用前一个事件。
 * refs.json 只是指针（ref → 末事件），删掉可以从文件名重建。
 */
export class Journal {
  readonly eventsDir: string;
  readonly refsPath: string;

  constructor(readonly dir: string) {
    this.eventsDir = join(dir, "events");
    this.refsPath = join(dir, "refs.json");
    mkdirSync(this.eventsDir, { recursive: true });
  }

  events(): StoredEvent[] {
    if (!existsSync(this.eventsDir)) return [];
    return readdirSync(this.eventsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.eventsDir, f), "utf8")) as StoredEvent)
      .sort((a, b) => a.seq - b.seq);
  }

  refs(): Record<string, { seq: number; hash: string }> {
    if (!existsSync(this.refsPath)) return {};
    return JSON.parse(readFileSync(this.refsPath, "utf8")) as Record<string, { seq: number; hash: string }>;
  }

  head(ref = "main"): { seq: number; hash: string } {
    return this.refs()[ref] ?? { seq: 0, hash: ZERO_HASH };
  }

  find(opid: string): StoredEvent | undefined {
    return this.events().find((e) => e.opid === opid);
  }

  append(input: AppendInput): StoredEvent {
    const events = this.events();
    const seq = events.length + 1;
    const ref = input.ref ?? "main";
    const prev = events.length > 0 ? events[events.length - 1].hash : ZERO_HASH;
    // 统一成"纯 JSON"：zod 会把显式 undefined 留在对象里，而 JSON.stringify 会丢掉它，
    // 两边不一致就会让哈希对不上（曾经因此误报过一次"事件被改过"）
    const payload = JSON.parse(JSON.stringify(parsePayload(input.op, input.payload)));
    const body = {
      apiVersion: "filmbench/v1",
      kind: "Event",
      seq,
      ref,
      op: input.op,
      actor: input.actor,
      at: input.at ?? new Date().toISOString(),
      opid: input.opid,
      base: input.base,
      payload,
    };
    const hash = hashOf(prev, body);
    const event: StoredEvent = {
      seq,
      hash,
      prev,
      ref,
      op: input.op,
      actor: input.actor,
      at: body.at,
      opid: input.opid,
      base: input.base,
      payload,
    };
    const file = join(this.eventsDir, `${String(seq).padStart(6, "0")}-${hash.slice(0, 12)}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(event, null, 2)}\n`);
    renameSync(tmp, file);

    const refs = this.refs();
    refs[ref] = { seq, hash };
    const refsTmp = `${this.refsPath}.tmp`;
    writeFileSync(refsTmp, `${JSON.stringify(refs, null, 2)}\n`);
    renameSync(refsTmp, this.refsPath);
    return event;
  }

  /** 哈希链与序号连续性校验：任何篡改都必须在这里暴露 */
  verify(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const events = this.events();
    let prev = ZERO_HASH;
    for (const [i, e] of events.entries()) {
      if (e.seq !== i + 1) problems.push(`序号断裂: 期望 ${i + 1}，实际 ${e.seq}`);
      if (e.prev !== prev) problems.push(`第 ${e.seq} 条的事件前驱不匹配`);
      const body = {
        apiVersion: "filmbench/v1",
        kind: "Event",
        seq: e.seq,
        ref: e.ref,
        op: e.op,
        actor: e.actor,
        at: e.at,
        opid: e.opid,
        base: e.base,
        payload: e.payload,
      };
      if (hashOf(prev, body) !== e.hash) problems.push(`第 ${e.seq} 条的哈希不匹配（内容被改过）`);
      prev = e.hash;
    }
    for (const [ref, ptr] of Object.entries(this.refs())) {
      const last = events.find((e) => e.ref === ref && e.seq === ptr.seq);
      if (!last) problems.push(`ref ${ref} 指向不存在的事件 ${ptr.seq}`);
      else if (last.hash !== ptr.hash) problems.push(`ref ${ref} 的哈希与事件不符`);
    }
    return { ok: problems.length === 0, problems };
  }
}
