#!/usr/bin/env bun
/**
 * filmbench CLI。所有命令都是 Service 的薄壳——没有任何一条命令绕过事件日志。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify as toYaml } from "yaml";
import {
  ConflictError,
  Service,
  ValidationError,
  build,
  compile,
  projectStoryboard,
  runJobs,
  submit,
  summarize,
  totalFrames,
} from "@filmbench/core";
import { builtinProviders } from "@filmbench/providers";
import { renderDocument } from "@filmbench/storyboard-audit";

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
  filmbench shot add --id --title --frames --provider --task [--prompt] [--desc] [--action] [--after]
  filmbench shot patch --id [--title] [--frames] [--prompt]
  filmbench plan
  filmbench jobs submit [--shot ID] [--all]
  filmbench jobs run [--job ID]
  filmbench status
  filmbench select --shot ID [--asset A]
  filmbench review --shot ID [--asset A] [--reject]
  filmbench build [--ir] [--out path]
  filmbench storyboard [--out path]
  filmbench ledger [--json]
  filmbench export [--out film.yaml]
  filmbench verify
  filmbench reindex
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
    out(`已创建 ${dir}\n  ${name} · ${values.width}×${values.height}@${values.fps}fps${values.budget ? ` · 预算 ${values.budget} USD` : ""}`);
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
        desc: { type: "string", default: "" },
        action: { type: "string", default: "" },
        after: { type: "string" },
        color: { type: "string" },
      },
    });
    if (!values.id || !values.title || !values.frames || !values.provider || !values.task) {
      throw new Error("shot add 需要 --id --title --frames --provider --task");
    }
    withService((svc) => {
      const state = svc.state();
      const byId = new Map(state.shots.map((s) => [s.id, s]));
      const { event } = svc.addShot(
        {
          id: values.id!,
          title: values.title!,
          durationFrames: Number(values.frames),
          intent: { description: values.desc!, action: values.action!, prompt: values.prompt! },
          binder: {
            provider: values.provider!,
            task: values.task!,
            params: values.color ? { color: values.color } : {},
          },
          subjects: [],
          references: [],
          dependsOn: values.after ? [{ shot: values.after, kind: "continuity" as const }] : [],
        },
        { actor: { kind: "human", id: "cli" } },
      );
      out(`已加镜头 ${values.id}（事件 #${event.seq}）`);
      void byId;
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
      },
    });
    if (!values.id) throw new Error("shot patch 需要 --id");
    withService((svc) => {
      const patch: Record<string, unknown> = {};
      if (values.title) patch.title = values.title;
      if (values.frames) patch.durationFrames = Number(values.frames);
      if (values.prompt) patch.intent = { prompt: values.prompt };
      const { event } = svc.patchShot(values.id!, patch, { actor: { kind: "human", id: "cli" } });
      out(`已更新 ${values.id}（事件 #${event.seq}）`);
    });
    return;
  }
  throw new Error(`未知子命令 shot ${sub ?? ""}`);
};

const cmdPlan = () =>
  withService((svc) => {
    const state = svc.state();
    if (!state.project) throw new Error("项目尚未创建");
    const rows = state.shots.map((shot) => {
      const produce = shot.produce;
      const status = !produce ? "缺产物" : shot.mutatedAt > produce.atSeq ? "过期" : "就位";
      const job = [...state.jobs.values()].find((j) => j.shot === shot.id);
      const sel = state.selections.get(shot.id);
      const selected = sel?.video ?? sel?.image ?? sel?.audio;
      const approved = selected ? state.reviews.get(`${shot.id}:${selected}`) === "approved" : false;
      const next = !produce
        ? job && job.phase === "rejected"
          ? `被预算拒绝：${job.reason}`
          : `filmbench jobs submit --shot ${shot.id}`
        : shot.mutatedAt > produce.atSeq
          ? `filmbench jobs submit --shot ${shot.id}`
          : !selected
            ? `filmbench select --shot ${shot.id}`
            : !approved
              ? `filmbench review --shot ${shot.id}`
              : "—";
      return [shot.id, `${shot.durationFrames}f`, shot.binder.provider, status, next];
    });
    out(table(rows, ["镜头", "时长", "provider", "状态", "下一步"]));
    out(`\n合计 ${totalFrames(state)} 帧（${(totalFrames(state) / state.project.format.fps).toFixed(2)}s）`);
  });

const cmdJobs = (argv: string[]) =>
  withServiceAsync(async (svc) => {
    const sub = argv[0];
    const registry = builtinProviders();
    if (sub === "submit") {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { shot: { type: "string" }, all: { type: "boolean" } },
      });
      const state = svc.state();
      const targets = values.all
        ? state.shots.filter((s) => !s.produce).map((s) => s.id)
        : values.shot
          ? [values.shot]
          : [];
      if (!targets.length) throw new Error("用 --shot <id> 或 --all 指定要提交的镜头");
      for (const shot of targets) {
        const result = submit(svc, registry, { shot, actor: { kind: "human", id: "cli" } });
        const price = result.estimate.priceUnknown
          ? "价格未知"
          : fmtMoney(result.estimate.amount, result.estimate.currency);
        out(`${result.jobId} ${result.phase}${result.reason ? ` · ${result.reason}` : ` · 预估 ${price}`}`);
      }
      return;
    }
    if (sub === "run" || sub === undefined) {
      const { values } = parseArgs({ args: argv.slice(1), options: { job: { type: "string" } } });
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
    const { values } = parseArgs({ args: argv, options: { ir: { type: "boolean" }, out: { type: "string" } } });
    const result = await build(svc, { irOnly: values.ir, out: values.out });
    if (values.ir) out(`IR 已写出：build/render.ir.json（${result.ir.clips.length} 段）`);
    else out(`成片 ${result.out}\n  ${result.durationFrames} 帧 · ${result.bytes} 字节 · sha256 ${result.sha256.slice(0, 12)}`);
  });

const cmdStoryboard = (argv: string[]) =>
  withService((svc, dir) => {
    const { values } = parseArgs({ args: argv, options: { out: { type: "string" } } });
    const registry = builtinProviders();
    const doc = projectStoryboard(svc, registry);
    const html = renderDocument(doc, {
      css: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/style.css"), "utf8"),
      client: readFileSync(join(import.meta.dir, "../../storyboard-audit/src/client.js"), "utf8"),
    });
    const target = resolve(values.out ?? join(dir, "build/storyboard.html"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    const blocked = doc.shots.filter((s) => (s.checks ?? []).some((c) => c.status === "fail")).length;
    out(`故事板 ${target}\n  ${doc.shots.length} 镜 · ${blocked} 镜有阻塞 · 修订 #${doc.revision.seq}`);
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
        return cmdInit(rest);
      case "shot":
        return cmdShot(rest);
      case "plan":
        return cmdPlan();
      case "jobs":
        return cmdJobs(rest);
      case "status":
        return cmdStatus();
      case "select":
        return cmdSelect(rest);
      case "review":
        return cmdReview(rest);
      case "build":
        return cmdBuild(rest);
      case "storyboard":
        return cmdStoryboard(rest);
      case "ledger":
        return cmdLedger(rest);
      case "export":
        return cmdExport(rest);
      case "verify":
        return cmdVerify();
      case "reindex":
        return cmdReindex();
      case "ui":
        return cmdUi(rest);
      case "mcp":
        return cmdMcp();
      case "agent":
        return cmdAgent(rest);
      case "demo":
        return cmdDemo(rest);
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
