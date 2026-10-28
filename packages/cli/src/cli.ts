#!/usr/bin/env bun
/**
 * filmbench CLI。所有命令都是 Service 的薄壳——没有任何一条命令绕过事件日志。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify as toYaml } from "yaml";
import {
  ConflictError,
  DEFAULT_POLICY,
  Service,
  ValidationError,
  ensurePosters,
  readPolicy,
  runChecks,
  alignCues,
  cueTimes,
  loadCues,
  shotStale,
  writePolicy,
  lintPrompt,
  build,
  compile,
  projectStoryboard,
  reconcileOrphans,
  runJobs,
  submit,
  summarize,
  totalFrames,
} from "@filmbench/core";
import { builtinProviders } from "@filmbench/providers";
import { renderDocument, resolvePreviews } from "@filmbench/storyboard-audit";

const VERSION = "0.0.1";

// 管道里被 head 之类提前关掉时不要抛栈：CLI 应该安静退出
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
process.stderr.on("error", () => {});

function findProject(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "journal"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("不在 filmbench 项目里（找不到 journal/）");
    dir = parent;
  }
}

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => [...(r[i] ?? "")].length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length));
  return all.map((r) => r.map((c, i) => pad(c ?? "", widths[i])).join("  ")).join("\n");
}

const fmtMoney = (n: number, currency: string) => `${n.toFixed(2)} ${currency}`;

function help(): void {
  out(`filmbench ${VERSION} —— 本地视频编排工作台

用法:
  filmbench init <dir> [--name] [--title] [--width 1920] [--height 1080] [--fps 30] [--budget 0]
  filmbench shot add --id --title --frames --provider --task [--role picture|music|voice] [--prompt] [--desc] [--action] [--after]
  filmbench shot patch --id [--title] [--frames] [--prompt] [--desc] [--action] [--provider] [--task]
  filmbench shot param --id [--set k=v]... [--unset k]...
  filmbench shot remove --id
  filmbench shot move --id <id> (--before <id> | --after <id>)
  filmbench asset add --file <path> [--name <name>]
  filmbench ref add --shot ID --asset A [--role identity|wardrobe|environment|first_frame|...]
  filmbench ref list|remove --shot ID [--asset A]
  filmbench prompt set --shot ID [--image "…"] [--video "…"] [--text "…"]
  filmbench prompt lint [--shot ID]
  filmbench plan
  filmbench jobs submit [--shot ID] [--all]
  filmbench jobs run [--job ID]
  filmbench jobs log --job ID
  filmbench jobs cancel --job ID | --all
  filmbench status
  filmbench select --shot ID [--asset A]
  filmbench review --shot ID [--asset A] [--reject]
  filmbench build [--ir] [--out path] [--force]   # --force：产物过期也强行出片
  filmbench storyboard [--out path] [--embed]   # --embed：把预览图内联进单文件
  filmbench assets
  filmbench ledger [--json]
  filmbench export [--out film.yaml]
  filmbench verify
  filmbench reindex
  filmbench colab up [--workflow comfy-h3] [--gpu L4]   # 建/复用会话（装一次环境）
  filmbench colab status | down | reap [--idle 30]
  filmbench script set --file script.md [--logline …] [--synopsis …] | show
  filmbench cover --shot ID
  filmbench cues [--shot ID] [--tolerance 0.06]
  filmbench info
  filmbench check                     # 一键验收（exit 1 = 不通过）
  filmbench doctor
  filmbench ui [--shot ID]
  filmbench mcp
  filmbench agent "<任务描述>"
  filmbench demo [<dir>]

所有命令都接受 --json 输出机器可读结果（部分命令除外）。`);
}

function withService<T>(fn: (svc: Service, dir: string) => T): T {
  const dir = findProject();
  const svc = Service.open(dir);
  try {
    return fn(svc, dir);
  } finally {
    svc.close();
  }
}

async function withServiceAsync<T>(fn: (svc: Service, dir: string) => Promise<T>): Promise<T> {
  const dir = findProject();
  const svc = Service.open(dir);
  try {
    return await fn(svc, dir);
  } finally {
    svc.close();
  }
}

const cmdInit = (argv: string[]) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      title: { type: "string" },
      width: { type: "string", default: "1920" },
      height: { type: "string", default: "1080" },
      fps: { type: "string", default: "30" },
      budget: { type: "string" },
    },
  });
  const dir = resolve(positionals[0] ?? ".");
  mkdirSync(dir, { recursive: true });
  const svc = Service.open(dir);
  try {
    if (svc.state().project) throw new Error(`已经有项目了：${dir}`);
    const name = values.name ?? dir.split("/").pop()!.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    svc.createProject(
      {
        name,
        title: values.title ?? name,
        format: { width: Number(values.width), height: Number(values.height), fps: Number(values.fps) },
        budget: values.budget ? { currency: "USD", limit: Number(values.budget) } : undefined,
      },
      { actor: { kind: "human", id: "cli" } },
    );
    writePolicy(dir, DEFAULT_POLICY);
    out(
      `已创建 ${dir}\n  ${name} · ${values.width}×${values.height}@${values.fps}fps${values.budget ? ` · 预算 ${values.budget} USD` : ""}\n` +
        `  渠道策略 .filmbench/policy.json：agent 只能用 ${DEFAULT_POLICY.allowedProviders.join(" / ")}${DEFAULT_POLICY.allowVideo ? "" : "，禁止自动用视频渠道"}`,
    );
  } finally {
    svc.close();
  }
};

const cmdShot = (argv: string[]) => {
  const sub = argv[0];
  if (sub === "add") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        id: { type: "string" },
        title: { type: "string" },
        frames: { type: "string" },
        provider: { type: "string" },
        task: { type: "string" },
        prompt: { type: "string", default: "" },
        "image-prompt": { type: "string", default: "" },
        "video-prompt": { type: "string", default: "" },
        ref: { type: "string", multiple: true },
        desc: { type: "string", default: "" },
        action: { type: "string", default: "" },
        narration: { type: "string", default: "" },
        after: { type: "string" },
        color: { type: "string" },
        role: { type: "string", default: "picture" },
        param: { type: "string", multiple: true },
      },
    });
    if (!values.id || !values.title || !values.frames || !values.provider || !values.task) {
      throw new Error("shot add 需要 --id --title --frames --provider --task");
    }
    withService((svc) => {
      const params: Record<string, string | number | boolean> = {};
      for (const pair of values.param ?? []) {
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new Error(`--param 需要 key=value：${pair}`);
        const key = pair.slice(0, eq);
        const raw = pair.slice(eq + 1);
        params[key] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      }
      if (values.color) params.color = values.color;
      const state = svc.state();
      const { event } = svc.addShot(
        {
          id: values.id!,
          title: values.title!,
          role: (values.role as "picture" | "music" | "voice") ?? "picture",
          durationFrames: Number(values.frames),
          intent: {
            description: values.desc!,
            action: values.action!,
            narration: values.narration!,
            prompt: values["image-prompt"] || values["video-prompt"] || values.prompt!,
            prompts: { image: values["image-prompt"]!, video: values["video-prompt"]! },
          },
          references: (values.ref ?? []).map((r) => {
            const [asset, role = "other"] = r.split(":");
            if (!state.assets.has(asset)) throw new Error(`素材未登记: ${asset}`);
            return { asset, role: role as any };
          }),
          binder: { provider: values.provider!, task: values.task!, params },
          subjects: [],
          dependsOn: values.after ? [{ shot: values.after, kind: "continuity" as const }] : [],
        },
        { actor: { kind: "human", id: "cli" } },
      );
      out(`已加镜头 ${values.id}（事件 #${event.seq}）`);
    });
    return;
  }
  if (sub === "move") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { id: { type: "string" }, before: { type: "string" }, after: { type: "string" } },
    });
    if (!values.id) throw new Error("shot move 需要 --id");
    withService((svc) => {
      const { event } = svc.moveShot(
        values.id!,
        values.before ? { before: values.before } : { after: values.after! },
        { actor: { kind: "human", id: "cli" } },
      );
      out(`已移动 ${values.id}${values.before ? ` 到 ${values.before} 之前` : ` 到 ${values.after} 之后`}（事件 #${event.seq}）`);
    });
    return;
  }
  if (sub === "param") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { id: { type: "string" }, set: { type: "string", multiple: true }, unset: { type: "string", multiple: true } },
    });
    if (!values.id) throw new Error("shot param 需要 --id");
    withService((svc) => {
      const shot = svc.state().shots.find((s) => s.id === values.id);
      if (!shot) throw new Error(`镜头不存在: ${values.id}`);
      const params: Record<string, string | number | boolean> = { ...shot.binder.params };
      for (const pair of values.set ?? []) {
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new Error(`--set 需要 key=value：${pair}`);
        const raw = pair.slice(eq + 1);
        params[pair.slice(0, eq)] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      }
      for (const key of values.unset ?? []) delete params[key];
      const { event, replayed } = svc.patchShot(shot.id, { binder: { params } }, { actor: { kind: "human", id: "cli" } });
      out(replayed ? `${shot.id} 参数没变，未写入事件` : `已更新 ${shot.id} 的参数（事件 #${event.seq}）：${JSON.stringify(params)}`);
    });
    return;
  }
  if (sub === "remove") {
    const { values } = parseArgs({ args: argv.slice(1), options: { id: { type: "string" } } });
    if (!values.id) throw new Error("shot remove 需要 --id");
    withService((svc) => {
      const { event } = svc.removeShot(values.id!, { actor: { kind: "human", id: "cli" } });
      out(`已删除 ${values.id}（事件 #${event.seq}）`);
    });
    return;
  }
  if (sub === "patch") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        id: { type: "string" },
        title: { type: "string" },
        frames: { type: "string" },
        prompt: { type: "string" },
        desc: { type: "string" },
        action: { type: "string" },
        narration: { type: "string" },
        provider: { type: "string" },
        task: { type: "string" },
      },
    });
    if (!values.id) throw new Error("shot patch 需要 --id");
    withService((svc) => {
      const patch: Record<string, unknown> = {};
      if (values.title) patch.title = values.title;
      if (values.frames) patch.durationFrames = Number(values.frames);
      const intent: Record<string, string> = {};
      if (values.prompt) intent.prompt = values.prompt;
      if (values.desc !== undefined) intent.description = values.desc;
      if (values.action !== undefined) intent.action = values.action;
      if (values.narration !== undefined) intent.narration = values.narration;
      if (Object.keys(intent).length) patch.intent = intent;
      if (values.provider || values.task) {
        patch.binder = {
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.task ? { task: values.task } : {}),
        };
      }
      const { event, replayed } = svc.patchShot(values.id!, patch, { actor: { kind: "human", id: "cli" } });
      out(replayed ? `${values.id} 没有变化，未写入事件` : `已更新 ${values.id}（事件 #${event.seq}）`);
    });
    return;
  }
  throw new Error(`未知子命令 shot ${sub ?? ""}`);
};

const cmdScript = (argv: string[]) =>
  withService((svc) => {
    const sub = argv[0];
    if (sub !== "set") throw new Error("用法: filmbench script set --file script.md [--logline …] [--synopsis …]");
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        file: { type: "string" },
        logline: { type: "string" },
        synopsis: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
      },
    });
    const body = values.file ? readFileSync(resolve(values.file), "utf8") : (values.text ?? "");
    if (!body.trim() && !values.logline) throw new Error("给 --file、--text 或 --logline");
    const { event } = svc.setScript(
      { body: body || undefined, logline: values.logline, synopsis: values.synopsis, title: values.title },
      { actor: { kind: "human", id: "cli" } },
    );
    out(`剧本已写入（事件 #${event.seq}，${body.length} 字）`);
  });

const cmdCover = (argv: string[]) =>
  withService((svc) => {
    const { values } = parseArgs({ args: argv, options: { shot: { type: "string" } } });
    if (!values.shot) throw new Error("cover 需要 --shot <id>");
    const { event } = svc.setCover(values.shot, { actor: { kind: "human", id: "cli" } });
    out(`封面取自 ${values.shot}（事件 #${event.seq}）`);
  });

const cmdCues = (argv: string[]) =>
  withService((svc, dir) => {
    const { values } = parseArgs({ args: argv, options: { shot: { type: "string" }, tolerance: { type: "string" } } });
    const state = svc.state();
    const track = values.shot
      ? state.shots.find((s) => s.id === values.shot)
      : state.shots.find((s) => s.binder.params.fit === "exact");
    if (!track) throw new Error("没有 fit: exact 的音轨镜头（用 --shot 指定）");
    const cuesPath = join(dir, String(track.binder.params.cues ?? ""));
    const cues = cueTimes(loadCues(cuesPath));
    const tolerance = Number(values.tolerance ?? track.binder.params.tolerance ?? 0.06);
    const rows = alignCues(state, cues, tolerance);
    out(`${track.id} · 卡点文件 ${track.binder.params.cues} · 容差 ${tolerance}s`);
    out(table(
      rows.map((r) => [
        r.ok ? "✓" : "✗",
        `${r.cut.toFixed(3)}s`,
        r.cue === null ? "—" : `${r.cue.toFixed(3)}s`,
        r.label ?? "",
        `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(3)}s`,
      ]),
      ["", "剪辑点", "最近段落", "段落", "偏差"],
    ));
    const bad = rows.filter((r) => !r.ok).length;
    out(bad ? `\n${bad} 个剪辑点没卡上` : `\n全部卡上（${rows.length} 个剪辑点）`);
    if (bad) process.exitCode = 1;
  });

const cmdInfo = () =>
  withService((svc, dir) => {
    const state = svc.state();
    if (!state.project) throw new Error("项目尚未创建");
    const fps = state.project.format.fps;
    out(`${state.project.title}  ·  ${state.project.name}`);
    if (state.script?.logline) out(`一句话：${state.script.logline}`);
    if (state.script?.synopsis) out(`梗概：${state.script.synopsis}`);
    out(
      `${state.shots.length} 镜 · ${state.shots.reduce((n, s) => n + s.durationFrames, 0)} 帧 / ${(
        state.shots.reduce((n, s) => n + s.durationFrames, 0) / fps
      ).toFixed(2)}s · 封面 ${state.cover ? state.cover.shot : "未设置"}`,
    );
    out("");
    out(table(
      state.shots.map((s, i) => [
        String(i + 1).padStart(2, "0"),
        s.id,
        `${(s.durationFrames / fps).toFixed(2)}s`,
        s.binder.provider,
        !s.produce ? "缺产物" : shotStale(state, s) ? "过期" : "就位",
        s.title,
      ]),
      ["#", "id", "时长", "provider", "状态", "标题"],
    ));
    if (state.script?.body) {
      out("");
      out(`剧本 ${state.script.body.length} 字（filmbench info 只摘要；完整内容在 filmbench script show）`);
    }
    void dir;
  });

const cmdScriptShow = () =>
  withService((svc) => {
    const s = svc.state().script;
    if (!s) return out("还没有剧本（filmbench script set --file script.md）");
    if (s.title) out(`# ${s.title}`);
    if (s.logline) out(`一句话：${s.logline}`);
    if (s.synopsis) out(`梗概：${s.synopsis}`);
    if (s.body) out(`\n${s.body}`);
  });

const cmdCheck = () =>
  withService((svc) => {
    const report = runChecks(svc, builtinProviders());
    for (const item of report.items) {
      const mark = item.ok ? "✓" : item.blocking ? "✗" : "!";
      out(`${mark} ${item.id.padEnd(12)} ${item.detail}`);
    }
    out(`\n${report.ok ? "验收通过" : "验收未通过"} · ${report.shots} 镜 / ${report.frames} 帧`);
    if (!report.ok) process.exitCode = 1;
  });

const cmdAsset = (argv: string[]) =>
  withService((svc, dir) => {
    if (argv[0] !== "add") throw new Error("用法: filmbench asset add --file <path> [--name <name>]");
    const { values } = parseArgs({ args: argv.slice(1), options: { file: { type: "string" }, name: { type: "string" } } });
    if (!values.file) throw new Error("asset add 需要 --file");
    const src = resolve(values.file);
    const bytes = readFileSync(src);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const asset = `asset-${digest.slice(0, 12)}`;
    const name = values.name ?? basename(src);
    const rel = join("assets", digest, name);
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) writeFileSync(dest, bytes);
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
    const { event } = svc.registerAsset(
      { asset, sha256: digest, bytes: bytes.byteLength, mime, path: rel },
      { actor: { kind: "human", id: "cli" } },
    );
    out(`已登记 ${asset}（${rel}）· 事件 #${event.seq}`);
  });

const cmdRef = (argv: string[]) =>
  withService((svc) => {
    const sub = argv[0];
    if (sub === "list") {
      const { values } = parseArgs({ args: argv.slice(1), options: { shot: { type: "string" } } });
      const shot = svc.state().shots.find((s) => s.id === values.shot);
      if (!shot) throw new Error(`镜头不存在: ${values.shot}`);
      if (!shot.references.length) return out("没有参考图");
      out(table(shot.references.map((r, i) => [`${i + 1}`, r.role, r.asset]), ["#", "用途", "素材"]));
      return;
    }
    if (sub === "add") {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { shot: { type: "string" }, asset: { type: "string" }, role: { type: "string", default: "other" } },
      });
      if (!values.shot || !values.asset) throw new Error("ref add 需要 --shot 和 --asset");
      const state = svc.state();
      const shot = state.shots.find((s) => s.id === values.shot);
      if (!shot) throw new Error(`镜头不存在: ${values.shot}`);
      if (!state.assets.has(values.asset)) throw new Error(`素材未登记: ${values.asset}`);
      if (shot.references.length >= 5) throw new Error("参考图已有 5 张（协议上限）");
      const references = [...shot.references, { asset: values.asset, role: values.role as any }];
      const { event } = svc.patchShot(shot.id, { references }, { actor: { kind: "human", id: "cli" } });
      out(`已添加参考 ${values.asset}（${values.role}）· 事件 #${event.seq}`);
      return;
    }
    if (sub === "remove") {
      const { values } = parseArgs({ args: argv.slice(1), options: { shot: { type: "string" }, asset: { type: "string" } } });
      if (!values.shot || !values.asset) throw new Error("ref remove 需要 --shot 和 --asset");
      const shot = svc.state().shots.find((s) => s.id === values.shot);
      if (!shot) throw new Error(`镜头不存在: ${values.shot}`);
      const references = shot.references.filter((r) => r.asset !== values.asset);
      if (references.length === shot.references.length) throw new Error(`该镜头没有 ${values.asset}`);
      svc.patchShot(shot.id, { references }, { actor: { kind: "human", id: "cli" } });
      out(`已移除 ${values.asset}`);
      return;
    }
    throw new Error(`未知子命令 ref ${sub ?? ""}`);
  });

const cmdPrompt = (argv: string[]) =>
  withService((svc) => {
    const sub = argv[0];
    if (sub === "set") {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { shot: { type: "string" }, image: { type: "string" }, video: { type: "string" }, text: { type: "string" } },
      });
      if (!values.shot) throw new Error("prompt set 需要 --shot");
      const shot = svc.state().shots.find((s) => s.id === values.shot);
      if (!shot) throw new Error(`镜头不存在: ${values.shot}`);
      const prompts = { ...shot.intent.prompts };
      if (values.image !== undefined) prompts.image = values.image;
      if (values.video !== undefined) prompts.video = values.video;
      const intent: Record<string, unknown> = { prompts };
      if (values.text !== undefined) intent.prompt = values.text;
      const r = svc.patchShot(shot.id, { intent } as any, { actor: { kind: "human", id: "cli" } });
      out(r.replayed ? `${shot.id} 的 prompt 没变，未写入事件` : `已更新 ${shot.id} 的 prompt`);
      return;
    }
    if (sub === "lint" || sub === undefined) {
      const { values } = parseArgs({ args: argv.slice(1), options: { shot: { type: "string" } } });
      const state = svc.state();
      const targets = values.shot ? state.shots.filter((s) => s.id === values.shot) : state.shots;
      if (!targets.length) throw new Error("没有可检查的镜头");
      const registry = builtinProviders();
      let failed = 0;
      for (const shot of targets) {
        const provider = registry.get(shot.binder.provider);
        const issues = lintPrompt(shot, provider);
        out(`${shot.id} · ${shot.binder.provider} · ${shot.references.length}/5 参考`);
        for (const i of issues) {
          const mark = i.status === "fail" ? "✗" : i.status === "warn" ? "▲" : "·";
          out(`  ${mark} ${i.id} — ${i.detail}`);
          if (i.status === "fail") failed++;
        }
        if (!issues.length) out("  ✓ 无问题");
      }
      if (failed) process.exitCode = 2;
      return;
    }
    throw new Error(`未知子命令 prompt ${sub}`);
  });

const cmdPlan = () =>
  withService((svc) => {
    const state = svc.state();
    if (!state.project) throw new Error("项目尚未创建");
    const rows = state.shots.map((shot) => {
      const produce = shot.produce;
      const status = !produce ? "缺产物" : shotStale(state, shot) ? "过期" : "就位";
      const role = (shot.role ?? "picture") === "picture" ? "" : ` · ${shot.role === "music" ? "配乐" : "人声"}`;
      const job = [...state.jobs.values()].find((j) => j.shot === shot.id);
      const sel = state.selections.get(shot.id);
      const selected = sel?.video ?? sel?.image ?? sel?.audio;
      const approved = selected ? state.reviews.get(`${shot.id}:${selected}`) === "approved" : false;
      const next = !produce
        ? job && job.phase === "rejected"
          ? job.rejectCause === "budget"
            ? `被预算拒绝：${job.reason}`
            : `上一次被取消，重新提交：filmbench jobs submit --shot ${shot.id}`
          : `filmbench jobs submit --shot ${shot.id}`
        : shotStale(state, shot)
          ? `filmbench jobs submit --shot ${shot.id}`
          : !selected
            ? `filmbench select --shot ${shot.id}`
            : selected !== produce.asset
              ? `filmbench select --shot ${shot.id}（新产物未选定）`
              : !approved
                ? `filmbench review --shot ${shot.id}`
                : "—";
      return [shot.id, `${shot.durationFrames}f`, `${shot.binder.provider}${role}`, status, next];
    });
    out(table(rows, ["镜头", "时长", "provider", "状态", "下一步"]));
    out(`\n合计 ${totalFrames(state)} 帧（${(totalFrames(state) / state.project.format.fps).toFixed(2)}s）`);
  });

const PHASE_ZH_CLI: Record<string, string> = { requested: "排队", running: "执行中", done: "完成", failed: "失败", rejected: "被拒" };

const cmdJobs = (argv: string[]) =>
  withServiceAsync(async (svc) => {
    const sub = argv[0];
    const registry = builtinProviders();
    if (sub === "submit") {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { shot: { type: "string" }, all: { type: "boolean" }, approve: { type: "boolean" } },
      });
      const state = svc.state();
      const targets = values.all
        ? state.shots
            .filter((s) => !s.produce || shotStale(state, s))
            .map((s) => s.id)
        : values.shot
          ? [values.shot]
          : [];
      if (!targets.length) throw new Error("用 --shot <id> 或 --all 指定要提交的镜头");
      for (const shot of targets) {
        const result = submit(svc, registry, {
          shot,
          actor: { kind: "human", id: "cli" },
          approve: Boolean(values.approve),
        });
        const price = result.estimate.priceUnknown
          ? "价格未知"
          : fmtMoney(result.estimate.amount, result.estimate.currency);
        out(`${result.jobId} ${result.phase}${result.reason ? ` · ${result.reason}` : ` · 预估 ${price}`}`);
      }
      return;
    }
    if (sub === "log") {
      const { values } = parseArgs({ args: argv.slice(1), options: { job: { type: "string" } } });
      if (!values.job) throw new Error("jobs log 需要 --job <id>");
      const job = svc.state().jobs.get(values.job);
      if (!job) throw new Error(`作业不存在: ${values.job}`);
      out(`${job.jobId} · ${PHASE_ZH_CLI[job.phase] ?? job.phase}${job.reason ? ` · ${job.reason}` : ""}`);
      if (!job.log?.length) out("（没有捕获到输出）");
      else out(job.log.join("\n"));
      return;
    }
    if (sub === "cancel") {
      const { values } = parseArgs({ args: argv.slice(1), options: { job: { type: "string" }, all: { type: "boolean" } } });
      const state = svc.state();
      const queued = [...state.jobs.values()].filter(
        (j) => j.phase === "requested" && (values.job ? j.jobId === values.job : Boolean(values.all)),
      );
      if (!queued.length) throw new Error("没有可取消的排队作业（用 --job ID 或 --all）");
      for (const job of queued) {
        svc.append("job.rejected", { jobId: job.jobId, reason: "手动取消", cause: "cancelled" }, { actor: { kind: "human", id: "cli" } });
      }
      out(`已取消 ${queued.length} 个作业`);
      return;
    }
    if (sub === "run" || sub === undefined) {
      const { values } = parseArgs({ args: argv.slice(1), options: { job: { type: "string" } } });
      const orphans = reconcileOrphans(svc);
      if (orphans > 0) out(`清理了 ${orphans} 个中断的作业（上次进程没跑完）`);
      const results = await runJobs(svc, registry, {
        jobId: values.job,
        onLog: (l) => process.stderr.write(`  ${l}\n`),
      });
      if (!results.length) out("没有待执行的作业");
      for (const r of results) {
        out(`${r.jobId} ${r.ok ? "完成" : "失败"}${r.asset ? ` → ${r.asset}` : ""}${r.reason ? ` · ${r.reason}` : ""}`);
      }
      return;
    }
    throw new Error(`未知子命令 jobs ${sub}`);
  });

const cmdSelect = (argv: string[]) =>
  withService((svc) => {
    const { values } = parseArgs({ args: argv, options: { shot: { type: "string" }, asset: { type: "string" } } });
    if (!values.shot) throw new Error("select 需要 --shot");
    const state = svc.state();
    const shot = state.shots.find((s) => s.id === values.shot);
    if (!shot) throw new Error(`镜头不存在: ${values.shot}`);
    if (!shot.produce) throw new Error(`${values.shot} 还没有产物，先跑作业`);
    const asset = values.asset ?? shot.produce.asset;
    if (!state.assets.has(asset)) throw new Error(`素材未登记: ${asset}`);
    const { event } = svc.setSelection(shot.id, shot.produce.kind, asset, { actor: { kind: "human", id: "cli" } });
    out(`已选定 ${shot.id} → ${asset}（事件 #${event.seq}）\n下一步：filmbench review --shot ${shot.id}`);
  });

const cmdReview = (argv: string[]) =>
  withService((svc) => {
    const { values } = parseArgs({
      args: argv,
      options: { shot: { type: "string" }, asset: { type: "string" }, reject: { type: "boolean" } },
    });
    if (!values.shot) throw new Error("review 需要 --shot");
    const state = svc.state();
    const sel = state.selections.get(values.shot);
    const asset = values.asset ?? sel?.video ?? sel?.image ?? sel?.audio;
    if (!asset) throw new Error(`${values.shot} 还没有选定素材，先 select`);
    const decision = values.reject ? "rejected" : "approved";
    const { event } = svc.decideReview(values.shot, asset, decision, { actor: { kind: "human", id: "cli" } });
    out(`已${decision === "approved" ? "批准" : "否决"} ${values.shot} / ${asset}（事件 #${event.seq}）`);
  });

const cmdStatus = () =>
  withService((svc, dir) => {
    const state = svc.state();
    const verified = svc.verify();
    const rows = [...state.jobs.values()].map((j) => [j.jobId, j.shot, j.phase, j.reason ?? ""]);
    out(
      `项目 ${state.project?.name ?? "—"} · ${state.project?.format.width}×${state.project?.format.height}@${state.project?.format.fps}fps`,
    );
    out(`镜头 ${state.shots.length} · 素材 ${state.assets.size} · 作业 ${state.jobs.size} · 事件 #${state.head.seq}`);
    out(`哈希链 ${verified.ok ? "完整" : `损坏：${verified.problems.join("; ")}`}`);
    if (rows.length) out(`\n${table(rows, ["作业", "镜头", "状态", "原因"])}`);
    const s = summarize(state);
    out(`\n花费 ${fmtMoney(s.spent, s.currency)}${s.unknownPriceCalls ? `（另有 ${s.unknownPriceCalls} 次价格未知）` : ""}`);
    if (s.budget) out(`预算 ${fmtMoney(s.budget.limit, s.currency)} · 剩余 ${fmtMoney(s.budget.remaining, s.currency)}`);
    const { ir, issues } = compile(state, dir);
    out(ir ? `编译 IR 就绪（${ir.clips.length} 段 / ${ir.totalFrames} 帧）` : `无法编译：${issues.map((i) => i.code).join(", ")}`);
  });

const cmdBuild = (argv: string[]) =>
  withServiceAsync(async (svc) => {
    const { values } = parseArgs({
      args: argv,
      options: { ir: { type: "boolean" }, out: { type: "string" }, force: { type: "boolean" } },
    });
    const result = await build(svc, { irOnly: values.ir, out: values.out, force: values.force });
    if (values.ir) out(`IR 已写出：build/render.ir.json（${result.ir.clips.length} 段）`);
    else out(`成片 ${result.out}\n  ${result.durationFrames} 帧 · ${result.bytes} 字节 · sha256 ${result.sha256.slice(0, 12)}`);
  });

const cmdStoryboard = (argv: string[]) =>
  withServiceAsync(async (svc, dir) => {
    const { values } = parseArgs({ args: argv, options: { out: { type: "string" }, embed: { type: "boolean" } } });
    const registry = builtinProviders();
    await ensurePosters(svc);
    const doc = projectStoryboard(svc, registry);
    const target = resolve(values.out ?? join(dir, "build/storyboard.html"));
    const resolved = resolvePreviews(doc, dirname(target), { embed: values.embed });
    const html = renderDocument(resolved, {
      css: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/style.css"), "utf8"),
      client: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/client.js"), "utf8"),
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    const blocked = doc.shots.filter((s) => (s.checks ?? []).some((c) => c.status === "fail")).length;
    out(
      `故事板 ${target}\n  ${doc.shots.length} 镜 · ${blocked} 镜有阻塞 · 修订 #${doc.revision.seq}${values.embed ? " · 媒体已内联" : ""}`,
    );
  });

const cmdAssets = () =>
  withService((svc) => {
    const state = svc.state();
    if (!state.assets.size) return out("还没有登记素材");
    const rows = [...state.assets.values()].map((a) => [
      a.asset,
      a.mime,
      `${(a.bytes / 1024).toFixed(0)} KB`,
      a.lineage?.provider ?? "—",
      a.path,
    ]);
    out(table(rows, ["素材", "类型", "体积", "来源", "路径"]));
  });

const cmdLedger = (argv: string[]) =>
  withService((svc) => {
    const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } });
    const s = summarize(svc.state());
    if (values.json) {
      out(JSON.stringify(s, null, 2));
      return;
    }
    out(`币种 ${s.currency} · 已花 ${fmtMoney(s.spent, s.currency)} · 待执行预估 ${fmtMoney(s.estimated, s.currency)}`);
    if (s.unknownPriceCalls) out(`价格未知的调用 ${s.unknownPriceCalls} 次（未计入金额）`);
    if (s.byProvider.length) out(`\n${table(s.byProvider.map((r) => [r.provider, String(r.calls), fmtMoney(r.amount, s.currency)]), ["provider", "次数", "金额"])}`);
    if (s.byShot.length) out(`\n${table(s.byShot.map((r) => [r.shot, String(r.calls), fmtMoney(r.amount, s.currency)]), ["镜头", "次数", "金额"])}`);
  });

const cmdExport = (argv: string[]) =>
  withService((svc, dir) => {
    const { values } = parseArgs({ args: argv, options: { out: { type: "string" } } });
    const film = svc.exportFilm();
    const target = resolve(values.out ?? join(dir, "film.yaml"));
    writeFileSync(target, toYaml(film));
    out(`已导出 ${target}（${film.shots.length} 个镜头）`);
  });

const cmdVerify = () =>
  withService((svc) => {
    const result = svc.verify();
    if (result.ok) out(`哈希链完整（${svc.head().seq} 条事件）`);
    else {
      err(`哈希链损坏：\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
      process.exitCode = 1;
    }
  });

const cmdReindex = () =>
  withService((svc) => {
    const { events } = svc.reindex();
    out(`索引已从事件重建（${events} 条）`);
  });

const sh = (cmd: string[]) => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
};

const cmdColab = (argv: string[]) =>
  withServiceAsync(async (svc, dir) => {
    const { colabUp, colabDown, colabReap, colabStatus, colabWorkflowDir } = await import("@filmbench/providers");
    const sub = argv[0] ?? "status";
    if (sub === "up") {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { workflow: { type: "string", default: "comfy-h3" }, gpu: { type: "string" } },
      });
      colabWorkflowDir(dir, values.workflow!); // 早失败：找不到工作流就先报
      const state = await colabUp({ projectDir: dir, workflow: values.workflow, gpu: values.gpu, onLog: (l) => out(l) });
      out(`会话 ${state.session}（${state.gpu}）· 工作流 ${state.workflow} · 空闲 ${state.idleMinutes} 分钟后自动停`);
      return;
    }
    if (sub === "down") {
      const stopped = await colabDown({ projectDir: dir, onLog: (l) => out(l) });
      out(stopped ? "已停止" : "没有记录的会话");
      return;
    }
    if (sub === "reap") {
      const { values } = parseArgs({ args: argv.slice(1), options: { idle: { type: "string" } } });
      const r = await colabReap({
        projectDir: dir,
        idleMinutes: values.idle ? Number(values.idle) : undefined,
        onLog: (l) => out(l),
      });
      if (!r.stopped) out(r.idle === null ? "没有记录的会话" : `空闲 ${r.idle.toFixed(0)} 分钟，未到阈值`);
      return;
    }
    if (sub === "status") {
      const st = await colabStatus(dir);
      if (!st.state) {
        out("没有正在跟踪的 Colab 会话（filmbench colab up 创建）");
      } else {
        out(`本项目会话 ${st.state.session} · ${st.state.gpu} · ${st.state.workflow}`);
        out(`存活 ${st.alive ? "是" : "否"} · 空闲 ${st.idleMinutes?.toFixed(0) ?? "?"} 分钟 / 阈值 ${st.state.idleMinutes}`);
        out(`远端 ${st.state.remoteDir} · persist ${st.state.persist}`);
      }
      if (st.others.length) {
        out(`\n其它活跃会话（不是本项目起的，不会被 filmbench 自动停）：`);
        for (const s of st.others) out(`  - ${s.name}${s.hardware ? ` · ${s.hardware}` : ""}`);
      }
      if (st.usage.length) out(`\n额度：${st.usage.join(" · ")}`);
      return;
    }
    throw new Error(`未知子命令 colab ${sub}`);
  });

const cmdDoctor = async () => {
  const rows: [string, boolean, string][] = [];
  const ff = sh(["ffmpeg", "-version"]);
  rows.push(["ffmpeg", ff.ok, ff.ok ? ff.out.split("\n")[0].slice(0, 40) : "缺少 ffmpeg（brew install ffmpeg）"]);
  rows.push(["ffprobe", Boolean(Bun.which("ffprobe")), Bun.which("ffprobe") ?? "缺少 ffprobe"]);

  const electron = join(resolve(import.meta.dir, "../../.."), "apps/desktop/node_modules/.bin/electron");
  rows.push(["electron", existsSync(electron), existsSync(electron) ? "已安装（开发模式）" : "bun install 后可用"]);

  let piVersion = "";
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    piVersion = String((pi as any).VERSION ?? "installed");
    rows.push(["pi 核心", true, `已安装 ${piVersion} · 内置 agent 可用`]);
  } catch {
    rows.push(["pi 核心", false, "未安装：bun add @earendil-works/pi-coding-agent"]);
  }

  const colab = sh(["colab", "version"]);
  const colabAuth = colab.ok ? sh(["colab", "--auth", "adc", "sessions"]) : { ok: false, out: "", err: "" };
  rows.push([
    "colab",
    colab.ok,
    colab.ok ? `v${(colab.out.match(/\d+\.\d+\.\d+/) ?? ["?"])[0]}${colabAuth.ok ? " · ADC 可用" : " · 未登录（colab --auth adc sessions）"}` : "未安装",
  ]);

  const imagine = sh(["imagine", "version"]);
  let usable = 0;
  let modelHint = "";
  if (imagine.ok) {
    const models = sh(["imagine", "models", "--json"]);
    try {
      const list = JSON.parse(models.out) as any[];
      const ok = list.filter((m) => ["configured", "ok", "not_required", "present"].includes(m.credential_status));
      usable = ok.length;
      modelHint = ok.slice(0, 4).map((m) => m.name).join(", ");
    } catch {}
  }
  const envKeys = ["AZURE_OPENAI_APIKEY", "ARK_API_KEY", "GEMINI_API_KEY"].filter((k) => Boolean(process.env[k]));
  rows.push([
    "imagine",
    imagine.ok && usable > 0,
    imagine.ok
      ? `${usable} 个已配置模型${modelHint ? `（${modelHint}${usable > 4 ? " …" : ""}）` : ""}${
          envKeys.length ? ` · 环境变量 ${envKeys.join("/")}` : " · 没有凭据环境变量"
        }${process.env.FILMBENCH_IMAGINE_ENV_FILE ? ` · envFile ${process.env.FILMBENCH_IMAGINE_ENV_FILE}` : ""}`
      : "未安装（brew install jamiesun/tap/imagine 或官方脚本）",
  ]);

  for (const [name, ok, detail] of rows) out(`${ok ? "✓" : "✗"} ${name.padEnd(10)} ${detail}`);
  if (rows.some((r) => !r[1])) {
    out("\n有组件不可用：带 ✗ 的项按提示补齐。缺 ffmpeg 会直接导致出片失败；缺 imagine/colab/pi 只影响对应能力。");
  }
  out("\n“已配置”只说明凭据在，能不能真调到要跑一次：filmbench jobs submit --shot <id> && filmbench jobs run");
  const state = (() => {
    try {
      return Service.open(findProject()).state();
    } catch {
      return null;
    }
  })();
  if (state?.project) out(`\n当前项目 ${state.project.name} · ${state.shots.length} 镜 · 事件 #${state.head.seq}`);
};

const cmdUi = (argv: string[]) =>
  withService((svc, dir) => {
    const { values } = parseArgs({ args: argv, options: { shot: { type: "string" } } });
    const repo = resolve(import.meta.dir, "../../..");
    const electron = join(repo, "apps/desktop/node_modules/.bin/electron");
    if (!existsSync(electron)) {
      err(`electron 未安装。先运行: cd ${repo} && bun install`);
      process.exitCode = 1;
      return;
    }
    const child = Bun.spawn(
      [electron, ".", `--project=${dir}`, ...(values.shot ? [`--shot=${values.shot}`] : [])],
      {
        cwd: join(repo, "apps/desktop"),
        env: { ...process.env, FILMBENCH_PROJECT: dir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    child.unref();
    out(`已打开界面 · ${dir}${values.shot ? ` · ${values.shot}` : ""}`);
    void svc;
  });

const cmdMcp = () =>
  withServiceAsync(async (svc, dir) => {
    const { serveStdio } = await import("../../mcp/src/server.ts");
    await serveStdio(svc, dir);
  });

const cmdAgent = (argv: string[]) =>
  withServiceAsync(async (svc, dir) => {
    const prompt = argv.join(" ").trim();
    if (!prompt) throw new Error('用法: filmbench agent "<任务描述>"');
    const { runAgent } = await import("../../agent/src/session.ts");
    await runAgent(svc, dir, prompt);
  });

const cmdDemo = (argv: string[]) => {
  const dir = resolve(argv[0] ?? "demo");
  mkdirSync(dir, { recursive: true });
  const svc = Service.open(dir);
  const registry = builtinProviders();
  try {
    if (!svc.state().project) {
      svc.createProject(
        {
          name: "demo",
          title: "演示片 · 四镜",
          format: { width: 640, height: 360, fps: 30 },
          budget: { currency: "USD", limit: 1 },
        },
        { actor: { kind: "human", id: "cli" } },
      );
      const shots = [
        { id: "shot-open", title: "开场", frames: 60, color: "0x1a2733", prompt: "wide opening" },
        { id: "shot-mid", title: "中段", frames: 45, color: "0x2b1f2a", prompt: "closer" },
        { id: "shot-turn", title: "转折", frames: 75, color: "0x1d2a24", prompt: "turn" },
        { id: "shot-end", title: "收尾", frames: 60, color: "0x2a2118", prompt: "ending" },
      ];
      for (const [i, s] of shots.entries()) {
        svc.addShot(
          {
            id: s.id,
            title: s.title,
            durationFrames: s.frames,
            intent: { description: `${s.title}镜头`, action: "", prompt: s.prompt },
            binder: { provider: "filmbench/colorcard", task: "clip", params: { color: s.color } },
            subjects: [],
            references: [],
            dependsOn: i > 0 ? [{ shot: shots[i - 1].id, kind: "continuity" }] : [],
          },
          { actor: { kind: "human", id: "cli" } },
        );
      }
    }
    const state = svc.state();
    for (const shot of state.shots.filter((s) => !s.produce)) {
      try {
        submit(svc, registry, { shot: shot.id, actor: { kind: "system", id: "demo" } });
      } catch (e) {
        out(`跳过 ${shot.id}: ${(e as Error).message}`);
      }
    }
    return runJobs(svc, registry).then(() => {
      const after = svc.state();
      for (const shot of after.shots) {
        if (!shot.produce) continue;
        const sel = after.selections.get(shot.id);
        if (!sel) svc.setSelection(shot.id, shot.produce.kind, shot.produce.asset, { actor: { kind: "human", id: "demo" } });
        svc.decideReview(shot.id, shot.produce.asset, "approved", { actor: { kind: "human", id: "demo" } });
      }
      const { ir } = compile(svc.state(), dir);
      out(`IR: ${ir ? `${ir.clips.length} 段 / ${ir.totalFrames} 帧` : "无法编译"}`);
      out(`下一步：cd ${dir} && filmbench build && filmbench storyboard`);
      svc.close();
    });
  } catch (e) {
    svc.close();
    throw e;
  }
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init":
        return await cmdInit(rest);
      case "shot":
        return await cmdShot(rest);
      case "script":
        return await (rest[0] === "show" ? cmdScriptShow() : cmdScript(rest));
      case "cover":
        return await cmdCover(rest);
      case "cues":
        return await cmdCues(rest);
      case "info":
        return await cmdInfo();
      case "check":
        return await cmdCheck();
      case "asset":
        return await cmdAsset(rest);
      case "ref":
        return await cmdRef(rest);
      case "prompt":
        return await cmdPrompt(rest);
      case "plan":
        return await cmdPlan();
      case "jobs":
        return await cmdJobs(rest);
      case "status":
        return await cmdStatus();
      case "select":
        return await cmdSelect(rest);
      case "review":
        return await cmdReview(rest);
      case "build":
        return await cmdBuild(rest);
      case "storyboard":
        return await cmdStoryboard(rest);
      case "assets":
        return await cmdAssets();
      case "ledger":
        return await cmdLedger(rest);
      case "export":
        return await cmdExport(rest);
      case "verify":
        return await cmdVerify();
      case "reindex":
        return await cmdReindex();
      case "colab":
        return await cmdColab(rest);
      case "doctor":
        return await cmdDoctor();
      case "ui":
        return await cmdUi(rest);
      case "mcp":
        return await cmdMcp();
      case "agent":
        return await cmdAgent(rest);
      case "demo":
        return await cmdDemo(rest);
      case undefined:
      case "help":
      case "--help":
        return help();
      case "version":
      case "--version":
        out(VERSION);
        return;
      default:
        throw new Error(`未知命令 ${cmd}`);
    }
  } catch (e) {
    if (e instanceof ConflictError) {
      err(`${e.message}\n提示：重新读取状态后再提交（CLI 用当前 head 作为 base）。`);
      process.exitCode = 3;
      return;
    }
    if (e instanceof ValidationError) {
      err(e.message);
      process.exitCode = 2;
      return;
    }
    err((e as Error).message);
    process.exitCode = 1;
  }
}

await main();
