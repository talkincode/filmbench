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
  ensurePosters,
  pictureShots,
  readPolicy,
  runChecks,
  shotStale,
  projectStoryboard,
  reconcileOrphans,
  runJobs,
  shotDetail,
  submit,
  summarize,
} from "@filmbench/core";
import { builtinProviders, colabReap } from "@filmbench/providers";
import { renderDocument, resolvePreviews } from "@filmbench/storyboard-audit";

const registry = builtinProviders();
const reconciled: string[] = [];
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
    case "hello": {
      const { service } = svc(args.project as string | undefined);
      const n = reconcileOrphans(service);
      if (n > 0) reconciled.push(`${n} 个孤立作业`);
      return { engine: "filmbench-engine/0.0.1", defaultProject, reconciled };
    }
    case "state": {
      const { service, dir } = svc(args.project as string | undefined);
      const state = service.state();
      return {
        dir,
        project: state.project,
        head: state.head,
        totalFrames: pictureShots(state).reduce((n, s) => n + s.durationFrames, 0),
        shots: state.shots.map((s, i) => ({
          id: s.id,
          order: i + 1,
          role: s.role ?? "picture",
          title: s.title,
          // 音轨用实际产物时长（旁白生成长度不可预知）
          durationFrames:
            (s.role ?? "picture") !== "picture" && s.produce ? s.produce.durationFrames : s.durationFrames,
          startFrame: state.shots.slice(0, i).reduce((n, x) => n + x.durationFrames, 0),
          provider: s.binder.provider,
          task: s.binder.task,
          intent: s.intent,
          hasOutput: Boolean(s.produce),
          stale: s.produce ? shotStale(state, s) : false,
          asset: s.produce?.asset ?? null,
          kind: s.produce?.kind ?? null,
          selected: (() => {
            const sel = state.selections.get(s.id);
            return sel?.video ?? sel?.image ?? sel?.audio ?? null;
          })(),
        })),
        jobs: [...state.jobs.values()],
        renders: state.renders.slice(-5).map((r) => {
          const abs = r.out.startsWith("/") ? r.out : join(dir, r.out);
          return {
            out: r.out,
            absPath: abs,
            exists: existsSync(abs),
            bytes: r.bytes,
            sha256: r.sha256,
            durationFrames: r.durationFrames,
            atSeq: r.atSeq,
          };
        }),
        cost: summarize(state),
      };
    }
    case "overview": {
      const { service, dir } = svc(args.project as string | undefined);
      const state = service.state();
      const coverAsset = state.cover ? state.assets.get(state.cover.asset) : null;
      const cost = summarize(state);
      const perShot = new Map(cost.byShot.map((r) => [r.shot, r.amount]));
      const check = runChecks(service, registry);
      let cursor = 0;
      const shots = state.shots.map((s, i) => {
        const start = cursor;
        cursor += s.durationFrames;
        return {
          id: s.id,
          order: i + 1,
          role: s.role ?? "picture",
          title: s.title,
          // 音轨用实际产物时长（旁白生成长度不可预知）
          durationFrames:
            (s.role ?? "picture") !== "picture" && s.produce ? s.produce.durationFrames : s.durationFrames,
          startFrame: start,
          endFrame: cursor,
          provider: s.binder.provider,
          task: s.binder.task,
          hasOutput: Boolean(s.produce),
          stale: s.produce ? shotStale(state, s) : false,
          selected: (() => {
            const sel = state.selections.get(s.id);
            return sel?.video ?? sel?.image ?? sel?.audio ?? null;
          })(),
          cost: perShot.get(s.id) ?? 0,
        };
      });
      return {
        dir,
        project: state.project,
        script: state.script ?? null,
        cover: state.cover
          ? { shot: state.cover.shot, asset: state.cover.asset, absPath: coverAsset ? join(dir, coverAsset.path) : null }
          : null,
        policy: readPolicy(dir),
        head: state.head,
        totalFrames: cursor,
        shots,
        cost,
        checks: check,
        renders: state.renders.slice(-3),
        events: state.events.slice(-40).map((e) => {
          const p = e.payload as Record<string, unknown>;
          const brief =
            e.op === "shot.added"
              ? String((p.shot as any)?.title ?? "")
              : e.op === "shot.patched"
                ? Object.keys((p.patch as object) ?? {}).join(",")
                : e.op.startsWith("job.")
                  ? String(p.jobId ?? "")
                  : e.op === "cost.recorded"
                    ? `${p.provider} ${p.amount} ${p.currency}`
                    : e.op === "script.set"
                      ? "剧本"
                      : e.op === "cover.set"
                        ? String(p.shot ?? "")
                        : e.op === "selection.set"
                          ? `${p.shot} → ${p.asset}`
                          : "";
          return { seq: e.seq, op: e.op, actor: `${e.actor.kind}:${e.actor.id}`, at: e.at, brief };
        }),
      };
    }
    case "script_set": {
      const { service } = svc(args.project as string | undefined);
      return service.setScript(
        {
          title: args.title as string | undefined,
          logline: args.logline as string | undefined,
          synopsis: args.synopsis as string | undefined,
          body: args.body as string | undefined,
        },
        { actor: { kind: "human", id: "desktop" } },
      ).event.seq;
    }
    case "shot_move": {
      const { service } = svc(args.project as string | undefined);
      const anchor = args.before
        ? { before: String(args.before) }
        : { after: String(args.after ?? "") };
      if (!anchor.before && !anchor.after) throw new Error("shot_move 需要 before 或 after");
      return service.moveShot(String(args.id), anchor, { actor: { kind: "human", id: "desktop" } }).event.seq;
    }
    case "cover_set": {
      const { service } = svc(args.project as string | undefined);
      return service.setCover(String(args.shot), { actor: { kind: "human", id: "desktop" } }).event.seq;
    }
    case "check": {
      const { service } = svc(args.project as string | undefined);
      return runChecks(service, registry);
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
    case "cancel": {
      const { service } = svc(args.project as string | undefined);
      const queued = [...service.state().jobs.values()].filter((j) => j.phase === "requested");
      for (const job of queued) {
        service.append("job.rejected", { jobId: job.jobId, reason: "手动取消", cause: "cancelled" }, { actor: { kind: "human", id: "desktop" } });
      }
      return { cancelled: queued.length };
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
      await ensurePosters(service);
      const doc = resolvePreviews(projectStoryboard(service, registry), join(dir, "build"));
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
    case "narration_set": {
      const { service } = svc(args.project as string | undefined);
      const state = service.state();
      const shot = state.shots.find((s) => s.id === String(args.shot));
      if (!shot) throw new Error(`镜头不存在: ${args.shot}`);
      service.patchShot(shot.id, { intent: { narration: String(args.text ?? "") } } as any, {
        actor: { kind: "human", id: "desktop" },
      });
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
      if (!shot) throw new Error("镜头不存在");
      const assetId = args.asset ? String(args.asset) : shot.produce?.asset;
      if (!assetId) throw new Error("该镜头还没有产物");
      const asset = state.assets.get(assetId);
      if (!asset) throw new Error(`素材未登记: ${assetId}`);
      const source = asset.path.startsWith("/") ? asset.path : join(dir, asset.path);
      if (!existsSync(source)) throw new Error(`文件不存在: ${source}`);
      if (asset.mime.startsWith("image/")) return { path: source };
      const folder = join(dir, "build/posters");
      const target = join(folder, `${assetId}.jpg`);
      if (!existsSync(target)) {
        mkdirSync(folder, { recursive: true });
        const proc = Bun.spawn(
          ["ffmpeg", "-y", "-ss", "0", "-i", source, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", target],
          { stdout: "ignore", stderr: "ignore" },
        );
        if ((await proc.exited) !== 0) throw new Error("抽帧失败（ffmpeg）");
      }
      return { path: target };
    }
    case "job_log": {
      const project = args.project as string | undefined;
      const { service } = svc(project);
      const job = service.state().jobs.get(String(args.jobId));
      if (!job) throw new Error(`作业不存在: ${args.jobId}`);
      return { jobId: job.jobId, phase: job.phase, reason: job.reason ?? null, lines: job.log ?? [] };
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

// Colab 会话空闲回收：每 60 秒检查一次（默认 30 分钟），防止人走了 VM 继续烧 CU
setInterval(() => {
  for (const dir of services.keys()) {
    colabReap({ projectDir: dir, onLog: (l) => console.error(`[colab] ${l}`) }).catch(() => {});
  }
}, 60_000).unref?.();

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
