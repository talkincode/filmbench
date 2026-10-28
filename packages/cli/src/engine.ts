#!/usr/bin/env bun
/**
 * engine：给 Electron 壳用的 stdio JSON-RPC。
 * 一行一个请求 {id, cmd, args}，一行一个响应 {id, ok, data|error}。
 * 一个 engine 进程服务多个项目：每个项目一个 Service，同一套规则。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  Service,
  build,
  projectStoryboard,
  runJobs,
  shotDetail,
  submit,
  summarize,
} from "@filmbench/core";
import { builtinProviders } from "@filmbench/providers";
import { renderDocument } from "@filmbench/storyboard-audit";

const registry = builtinProviders();
const defaultProject = resolve(process.argv[2] ?? process.cwd());
const services = new Map<string, Service>();

function svc(dir?: string): { service: Service; dir: string } {
  const target = resolve(dir ?? defaultProject);
  if (!existsSync(join(target, "journal"))) throw new Error(`不是 filmbench 项目（缺 journal/）: ${target}`);
  let service = services.get(target);
  if (!service) {
    service = Service.open(target);
    services.set(target, service);
  }
  return { service, dir: target };
}

async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "hello":
      return { engine: "filmbench-engine/0.0.1", defaultProject };
    case "state": {
      const { service, dir } = svc(args.project as string | undefined);
      const state = service.state();
      return {
        dir,
        project: state.project,
        head: state.head,
        totalFrames: state.shots.reduce((n, s) => n + s.durationFrames, 0),
        shots: state.shots.map((s, i) => ({
          id: s.id,
          order: i + 1,
          title: s.title,
          durationFrames: s.durationFrames,
          startFrame: state.shots.slice(0, i).reduce((n, x) => n + x.durationFrames, 0),
          provider: s.binder.provider,
          task: s.binder.task,
          intent: s.intent,
          hasOutput: Boolean(s.produce),
          stale: s.produce ? s.mutatedAt > s.produce.atSeq : false,
          asset: s.produce?.asset ?? null,
          kind: s.produce?.kind ?? null,
          selected: (() => {
            const sel = state.selections.get(s.id);
            return sel?.video ?? sel?.image ?? sel?.audio ?? null;
          })(),
        })),
        jobs: [...state.jobs.values()],
        cost: summarize(state),
      };
    }
    case "shot_detail": {
      const { service } = svc(args.project as string | undefined);
      return shotDetail(service, registry, String(args.shot));
    }
    case "submit": {
      const { service } = svc(args.project as string | undefined);
      const shot = String(args.shot ?? "");
      const shots = shot ? [shot] : service.state().shots.filter((s) => !s.produce).map((s) => s.id);
      return shots.map((id) => submit(service, registry, { shot: id, actor: { kind: "human", id: "desktop" } }));
    }
    case "select": {
      const { service } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot?.produce) throw new Error("该镜头还没有产物");
      service.setSelection(shot.id, shot.produce.kind, String(args.asset ?? shot.produce.asset), {
        actor: { kind: "human", id: "desktop" },
      });
      return { ok: true };
    }
    case "review": {
      const { service } = svc(args.project as string | undefined);
      const state = service.state();
      const shotId = String(args.shot);
      const sel = state.selections.get(shotId);
      const asset = String(args.asset ?? sel?.video ?? sel?.image ?? sel?.audio ?? "");
      if (!asset) throw new Error("该镜头还没有选定素材");
      service.decideReview(shotId, asset, args.reject ? "rejected" : "approved", {
        actor: { kind: "human", id: "desktop" },
      });
      return { ok: true };
    }
    case "run": {
      const { service } = svc(args.project as string | undefined);
      return runJobs(service, registry);
    }
    case "build": {
      const { service } = svc(args.project as string | undefined);
      const r = await build(service, { irOnly: Boolean(args.irOnly) });
      return { out: r.out, durationFrames: r.durationFrames, sha256: r.sha256, bytes: r.bytes };
    }
    case "storyboard": {
      const { service, dir } = svc(args.project as string | undefined);
      const doc = projectStoryboard(service, registry);
      const html = renderDocument(doc, {
        css: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/style.css"), "utf8"),
        client: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/client.js"), "utf8"),
      });
      const target = join(dir, "build/storyboard.html");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html);
      return { out: target, shots: doc.shots.length };
    }
    case "ledger": {
      const { service } = svc(args.project as string | undefined);
      return summarize(service.state());
    }
    case "verify": {
      const { service } = svc(args.project as string | undefined);
      return service.verify();
    }
    case "assets": {
      const { service, dir } = svc(args.project as string | undefined);
      const state = service.state();
      return [...state.assets.values()].map((a) => ({
        asset: a.asset,
        mime: a.mime,
        bytes: a.bytes,
        path: a.path,
        absPath: join(dir, a.path),
        exists: existsSync(join(dir, a.path)),
        provider: a.lineage?.provider ?? null,
      }));
    }
    case "ref_add": {
      const { service, dir } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot) throw new Error(`镜头不存在: ${args.shot}`);
      if (shot.references.length >= 5) throw new Error("参考图已有 5 张（上限）");
      const asset = String(args.asset);
      if (!state.assets.has(asset)) throw new Error(`素材未登记: ${asset}`);
      service.patchShot(shot.id, { references: [...shot.references, { asset, role: (args.role as any) ?? "other" }] }, {
        actor: { kind: "human", id: "desktop" },
      });
      return { ok: true, references: shot.references.length + 1 };
    }
    case "ref_remove": {
      const { service } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot) throw new Error(`镜头不存在: ${args.shot}`);
      const references = shot.references.filter((r) => r.asset !== String(args.asset));
      service.patchShot(shot.id, { references }, { actor: { kind: "human", id: "desktop" } });
      return { ok: true, references: references.length };
    }
    case "ref_role": {
      const { service } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot) throw new Error(`镜头不存在: ${args.shot}`);
      const references = shot.references.map((r) =>
        r.asset === String(args.asset) ? { ...r, role: String(args.role) as any } : r,
      );
      service.patchShot(shot.id, { references }, { actor: { kind: "human", id: "desktop" } });
      return { ok: true };
    }
    case "prompt_set": {
      const { service } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot) throw new Error(`镜头不存在: ${args.shot}`);
      const prompts = { ...shot.intent.prompts };
      if (args.image !== undefined) prompts.image = String(args.image);
      if (args.video !== undefined) prompts.video = String(args.video);
      const intent: Record<string, unknown> = { prompts };
      if (args.text !== undefined) intent.prompt = String(args.text);
      service.patchShot(shot.id, { intent } as any, { actor: { kind: "human", id: "desktop" } });
      return { ok: true };
    }
    case "poster": {
      const { service, dir } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot?.produce) throw new Error("该镜头还没有产物");
      const folder = join(dir, "build/posters");
      const target = join(folder, `${shot.id}.jpg`);
      if (!existsSync(target)) {
        mkdirSync(folder, { recursive: true });
        const source = shot.produce.path.startsWith("/") ? shot.produce.path : join(dir, shot.produce.path);
        const proc = Bun.spawn(
          ["ffmpeg", "-y", "-ss", "0", "-i", source, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", target],
          { stdout: "ignore", stderr: "ignore" },
        );
        if ((await proc.exited) !== 0) throw new Error("抽帧失败（ffmpeg）");
      }
      return { path: target };
    }
    case "save_markup": {
      const { dir } = svc(args.project as string | undefined);
      const base64 = String(args.png ?? "");
      if (!base64) throw new Error("缺少图片数据");
      const folder = join(dir, "review");
      mkdirSync(folder, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(folder, `markup-${stamp}.png`);
      writeFileSync(file, Buffer.from(base64, "base64"));
      return { path: file, bytes: Buffer.from(base64, "base64").byteLength };
    }
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
    .catch((err: Error) => process.stdout.write(`${JSON.stringify({ id, ok: false, error: err.message })}\n`));
});

rl.on("close", () => {
  for (const s of services.values()) s.close();
  process.exit(0);
});
