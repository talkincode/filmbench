#!/usr/bin/env bun
/**
 * filmbench storyboard-audit —— 把只读投影渲染成单文件审计故事板。
 *
 *   bun packages/storyboard-audit/src/cli.ts --in fixtures/demo.storyboard.json --out out/storyboard.html
 *
 * 退出码：0 正常；1 输入不合法；2 --exit-on-blocker 且存在阻塞项。
 * 输出确定性：无时间戳、无随机、无外部资源。
 */
import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { derive } from "./audit.ts";
import { renderDocument } from "./render.ts";
import type { Shot, StoryboardDoc } from "./types.ts";

const HERE = import.meta.dir;

interface Args {
  in: string;
  out: string;
  exitOnBlocker: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { in: "", out: "", exitOnBlocker: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i] ?? "";
    else if (a === "--out") args.out = argv[++i] ?? "";
    else if (a === "--exit-on-blocker") args.exitOnBlocker = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        `用法: storyboard-audit --in <投影.json> --out <故事板.html> [--exit-on-blocker] [--json]\n\n` +
          `输入 schema: filmbench/storyboard-audit/v1（见 packages/storyboard-audit/README.md）\n`,
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      fail(`未知参数 ${a}`);
    }
  }
  if (!args.in) fail("缺少 --in");
  if (!args.out) fail("缺少 --out");
  return args;
}

function fail(message: string): never {
  process.stderr.write(`storyboard-audit: ${message}\n`);
  process.exit(1);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

/** 输入校验：宁可在这里拒绝，也不要在页面上渲染一个假的通过 */
function validate(doc: unknown): asserts doc is StoryboardDoc {
  assert(doc && typeof doc === "object", "输入必须是对象");
  const d = doc as Partial<StoryboardDoc>;
  assert(d.apiVersion === "filmbench/storyboard-audit/v1", `apiVersion 必须是 filmbench/storyboard-audit/v1，实际 ${String(d.apiVersion)}`);
  assert(d.project && Number.isInteger(d.project.fps) && d.project.fps > 0, "project.fps 必须是正整数");
  assert(Array.isArray(d.shots) && d.shots.length > 0, "shots 必须是非空数组");
  assert(d.revision && typeof d.revision.seq === "number", "revision.seq 必填");

  const ids = new Set<string>();
  for (const [i, shot] of d.shots.entries()) {
    const at = `shots[${i}]`;
    assert(shot && typeof shot === "object", `${at} 必须是对象`);
    assert(typeof shot.id === "string" && shot.id !== "", `${at}.id 必填`);
    assert(!ids.has(shot.id), `${at}.id 重复: ${shot.id}`);
    ids.add(shot.id);
    assert(typeof shot.title === "string", `${at}.title 必填`);
    assert(
      Number.isInteger(shot.durationFrames) && shot.durationFrames >= 0,
      `${at}.durationFrames 必须是非负整数（时间基是帧，不是秒）`,
    );
    assert(shot.intent && typeof shot.intent === "object", `${at}.intent 必填`);
    assert(
      shot.binder && typeof shot.binder.provider === "string" && typeof shot.binder.task === "string",
      `${at}.binder.provider / .task 必填`,
    );
    for (const p of shot.produces ?? []) {
      assert(typeof p.path === "string" && p.path !== "", `${at}.produces[].path 必填`);
      assert(typeof p.exists === "boolean", `${at}.produces[].exists 必须是布尔值（不做猜测）`);
    }
  }
  for (const [i, shot] of d.shots.entries()) {
    for (const dep of shot.dependsOn ?? []) {
      assert(ids.has(dep.shot), `shots[${i}].dependsOn 指向不存在的镜头 ${dep.shot}`);
      assert(dep.shot !== shot.id, `shots[${i}].dependsOn 不能指向自己`);
    }
  }
  void (null as unknown as Shot);
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2));
  const inPath = resolve(args.in);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(inPath, "utf8"));
  } catch (err) {
    fail(`读取 ${inPath} 失败: ${(err as Error).message}`);
  }
  validate(parsed);

  const { totals, findings } = derive(parsed);
  const html = renderDocument(parsed, {
    css: readFileSync(resolve(HERE, "style.css"), "utf8"),
    client: readFileSync(resolve(HERE, "client.js"), "utf8"),
  });

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, outPath);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          out: outPath,
          shots: totals.shots,
          frames: totals.frames,
          state: {
            ready: totals.ready,
            blocked: totals.blocked,
            missingArtifact: totals.missingArtifact,
            staleArtifact: totals.flaggedStale,
          },
          findings: { blockers: totals.blockers, warnings: totals.warnings, notes: totals.notes },
          cost: { currency: totals.currency, estimated: totals.costEstimated, actual: totals.costActual, cu: totals.cu },
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      `storyboard-audit: ${totals.shots} 镜 / ${totals.frames} 帧 / ` +
        `就位 ${totals.ready} · 阻塞 ${totals.blocked} · 缺产物 ${totals.missingArtifact} · 过期 ${totals.flaggedStale} / ` +
        `阻塞项 ${totals.blockers} · 告警 ${totals.warnings} · 提示 ${totals.notes} → ${outPath}\n`,
    );
  }

  if (args.exitOnBlocker && totals.blockers > 0) process.exit(2);
  void findings;
}

main();
