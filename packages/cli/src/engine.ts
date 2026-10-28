#!/usr/bin/env bun
/**
 * engine：给 Electron 壳用的 stdio JSON-RPC。
 * 一行一个请求 {id, cmd, args}，一行一个响应 {id, ok, data|error}。
 * 它和 CLI、MCP 共用同一个 Service；桌面端不拥有第二条写路径。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { renderDocument } from "@filmbench/storyboard-audit";
import { build, projectStoryboard, runJobs, submit, summarize } from "@filmbench/core";
import { Service } from "@filmbench/core";
import { builtinProviders } from "@filmbench/providers";

const projectDir = process.argv[2] ?? process.cwd();
const service = Service.open(projectDir);
const registry = builtinProviders();

async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "hello":
      return { engine: "filmbench-engine/0.0.1", projectDir };
    case "state": {
      const state = service.state();
      return {
        project: state.project,
        head: state.head,
        shots: state.shots.map((s) => ({
          id: s.id,
          title: s.title,
          durationFrames: s.durationFrames,
          provider: s.binder.provider,
          task: s.binder.task,
          intent: s.intent,
          hasOutput: Boolean(s.produce),
          stale: s.produce ? s.mutatedAt > s.produce.atSeq : false,
          asset: s.produce?.asset ?? null,
          checks: [],
        })),
        jobs: [...state.jobs.values()],
        cost: summarize(state),
      };
    }
    case "submit": {
      const shot = String(args.shot ?? "");
      const shots = shot ? [shot] : service.state().shots.filter((s) => !s.produce).map((s) => s.id);
      return shots.map((id) => submit(service, registry, { shot: id, actor: { kind: "human", id: "desktop" } }));
    }
    case "run":
      return runJobs(service, registry, { onLog: () => {} });
    case "build": {
      const r = await build(service, { irOnly: Boolean(args.irOnly) });
      return { out: r.out, durationFrames: r.durationFrames, sha256: r.sha256, bytes: r.bytes };
    }
    case "storyboard": {
      const doc = projectStoryboard(service, registry);
      const html = renderDocument(doc, {
        css: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/style.css"), "utf8"),
        client: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/client.js"), "utf8"),
      });
      const target = join(projectDir, "build/storyboard.html");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html);
      return { out: target, shots: doc.shots.length };
    }
    case "ledger":
      return summarize(service.state());
    case "verify":
      return service.verify();
    default:
      throw new Error(`未知命令 ${cmd}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: { id?: unknown; cmd?: string; args?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: "请求不是合法 JSON" })}\n`);
    return;
  }
  const id = req.id ?? null;
  Promise.resolve()
    .then(() => handle(String(req.cmd ?? ""), req.args ?? {}))
    .then((data) => process.stdout.write(`${JSON.stringify({ id, ok: true, data })}\n`))
    .catch((err: Error) =>
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: err.message })}\n`),
    );
});

rl.on("close", () => {
  service.close();
  process.exit(0);
});
