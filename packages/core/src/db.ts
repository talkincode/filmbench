import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredEvent } from "./journal.ts";

/**
 * sqlite 只是索引：事件日志是真相，这个库删掉可以从事件重建。
 * 它存在的理由是查询与游标（账本聚合、作业队列、素材检索），不是存储权威。
 */
export class Index {
  readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run("pragma journal_mode = wal");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      create table if not exists events (
        seq integer primary key,
        hash text not null,
        ref text not null,
        op text not null,
        actor text not null,
        at text not null,
        opid text not null unique,
        payload text not null
      );
      create table if not exists ops (opid text primary key, seq integer not null);
      create table if not exists ledger (
        seq integer primary key,
        job_id text,
        kind text not null,
        provider text not null,
        units text not null,
        unit_price real not null,
        amount real not null,
        currency text not null,
        price_unknown integer not null
      );
      create table if not exists jobs (
        job_id text primary key,
        shot text not null,
        provider text not null,
        task text not null,
        phase text not null,
        estimate real not null,
        currency text not null,
        updated_at integer not null
      );
      create table if not exists renders (
        seq integer primary key,
        out text not null,
        sha256 text not null,
        bytes integer not null,
        duration_frames integer not null
      );
      create virtual table if not exists search using fts5(kind, id, text, seq unindexed);
    `);
  }

  reset(): void {
    this.db.run(`delete from events; delete from ops; delete from ledger; delete from jobs; delete from renders; delete from search;`);
  }

  apply(event: StoredEvent): void {
    this.db
      .query(`insert or replace into events (seq, hash, ref, op, actor, at, opid, payload) values (?,?,?,?,?,?,?,?)`)
      .run(event.seq, event.hash, event.ref, event.op, event.actor.kind, event.at, event.opid, JSON.stringify(event.payload));
    this.db.query(`insert or replace into ops (opid, seq) values (?,?)`).run(event.opid, event.seq);
    const p = event.payload as any;
    if (event.op === "cost.recorded") {
      this.db
        .query(
          `insert or replace into ledger (seq, job_id, kind, provider, units, unit_price, amount, currency, price_unknown) values (?,?,?,?,?,?,?,?,?)`,
        )
        .run(event.seq, p.jobId ?? null, p.kind, p.provider, p.units, p.unitPrice, p.amount, p.currency, p.priceUnknown ? 1 : 0);
    }
    if (event.op === "job.requested") {
      this.db
        .query(`insert or replace into jobs (job_id, shot, provider, task, phase, estimate, currency, updated_at) values (?,?,?,?,?,?,?,?)`)
        .run(p.jobId, p.shot, p.provider, p.task, "requested", p.estimate.amount, p.estimate.currency, event.seq);
    }
    if (event.op.startsWith("job.")) {
      const phase =
        event.op === "job.started" ? "running" : event.op === "job.completed" ? "done" : event.op === "job.failed" ? "failed" : "rejected";
      this.db.query(`update jobs set phase = ?, updated_at = ? where job_id = ?`).run(phase, event.seq, p.jobId);
    }
    if (event.op === "render.completed") {
      this.db
        .query(`insert or replace into renders (seq, out, sha256, bytes, duration_frames) values (?,?,?,?,?)`)
        .run(event.seq, p.out, p.sha256, p.bytes, p.durationFrames);
    }
    if (event.op === "shot.added" || event.op === "shot.patched") {
      const shot = event.op === "shot.added" ? p.shot : p.patch;
      this.db.query(`delete from search where kind = 'shot' and id = ?`).run(event.op === "shot.added" ? p.shot.id : p.id);
      this.db
        .query(`insert into search (kind, id, text, seq) values ('shot', ?, ?, ?)`)
        .run(
          event.op === "shot.added" ? p.shot.id : p.id,
          [shot.title, shot.intent?.description, shot.intent?.prompt].filter(Boolean).join(" "),
          event.seq,
        );
    }
  }

  rebuild(events: StoredEvent[]): void {
    this.db.transaction(() => {
      this.reset();
      for (const e of events) this.apply(e);
    })();
  }

  findOp(opid: string): number | undefined {
    const row = this.db.query<{ seq: number }, [string]>(`select seq from ops where opid = ?`).get(opid);
    return row?.seq;
  }

  ledgerByProvider(): { provider: string; rows: number; amount: number; currency: string }[] {
    return this.db
      .query<{ provider: string; rows: number; amount: number; currency: string }, []>(
        `select provider, count(*) as rows, round(sum(amount), 6) as amount, currency
         from ledger where price_unknown = 0 group by provider, currency order by amount desc`,
      )
      .all();
  }

  pendingJobs(): { jobId: string; shot: string; provider: string; task: string; estimate: number; currency: string }[] {
    return this.db
      .query<{ jobId: string; shot: string; provider: string; task: string; estimate: number; currency: string }, []>(
        `select job_id as jobId, shot, provider, task, estimate, currency from jobs where phase = 'requested' order by updated_at`,
      )
      .all();
  }

  search(q: string): { kind: string; id: string }[] {
    return this.db
      .query<{ kind: string; id: string }, [string]>(`select kind, id from search where search match ? limit 50`)
      .all(q);
  }

  close(): void {
    this.db.close();
  }
}
