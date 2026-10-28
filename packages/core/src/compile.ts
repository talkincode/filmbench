import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Format } from "@filmbench/protocol";
import { PATHS, ValidationError, type Service } from "./service.ts";
import { totalFrames, type ProjectState } from "./state.ts";
import { shotStale } from "./stale.ts";

/**
 * Render IR：编译的唯一产物。声明式、逐字节确定、可 diff。
 * 预览与成片跑同一份 IR，只是参数不同——不存在第二套渲染路径。
 */
export interface RenderIR {
  ir: "filmbench/render-ir/v1";
  project: string;
  format: Format;
  totalFrames: number;
  clips: {
    shot: string;
    kind: "video" | "image";
    asset: string;
    sha256: string;
    path: string;
    durationFrames: number;
  }[];
  requirements: ("ffmpeg" | "ffprobe")[];
  output: { container: "mp4"; videoCodec: "libx264"; pixelFormat: "yuv420p"; audio: "none" };
}

export interface CompileIssue {
  code:
    | "no-project"
    | "no-shots"
    | "missing-output"
    | "stale-output"
    | "asset-file-missing"
    | "spec-mismatch"
    | "no-selection"
    | "selection-not-produced";
  shot?: string;
  detail: string;
}

export function compile(
  state: ProjectState,
  baseDir = ".",
  options: { allowStale?: boolean } = {},
): { ir: RenderIR | null; issues: CompileIssue[] } {
  const issues: CompileIssue[] = [];
  if (!state.project) return { ir: null, issues: [{ code: "no-project", detail: "项目尚未创建" }] };
  if (state.shots.length === 0) issues.push({ code: "no-shots", detail: "没有任何镜头" });

  const clips: RenderIR["clips"] = [];
  for (const shot of state.shots) {
    if (!shot.produce) {
      issues.push({ code: "missing-output", shot: shot.id, detail: "没有已完成作业的产物" });
      continue;
    }
    const sel = state.selections.get(shot.id);
    const selected = sel?.video ?? sel?.image ?? sel?.audio;
    if (!selected) {
      issues.push({ code: "no-selection", shot: shot.id, detail: "产物没有被选定（选片是独立的一步，不是默认生效）" });
      continue;
    }
    if (selected !== shot.produce.asset) {
      issues.push({
        code: "selection-not-produced",
        shot: shot.id,
        detail: `选定了 ${selected}，但当前产物是 ${shot.produce.asset}`,
      });
      continue;
    }
    const p = shot.produce;
    if (!options.allowStale && shotStale(state, shot)) {
      issues.push({
        code: "stale-output",
        shot: shot.id,
        detail: `输入变了（意图/参考/参数），产物停在 #${p.atSeq}：重新生成，或 build --force 强行出片`,
      });
    }
    if (p.kind === "video" && (p.width !== state.project.format.width || p.height !== state.project.format.height)) {
      issues.push({
        code: "spec-mismatch",
        shot: shot.id,
        detail: `产物 ${p.width}×${p.height} ≠ 成片 ${state.project.format.width}×${state.project.format.height}`,
      });
    }
    if (p.kind === "video" && p.durationFrames !== shot.durationFrames) {
      issues.push({
        code: "spec-mismatch",
        shot: shot.id,
        detail: `产物 ${p.durationFrames} 帧 ≠ 镜头声明 ${shot.durationFrames} 帧`,
      });
    }
    if (!existsSync(join(baseDir, p.path))) {
      issues.push({ code: "asset-file-missing", shot: shot.id, detail: `文件不存在: ${p.path}` });
    }
    clips.push({
      shot: shot.id,
      kind: p.kind,
      asset: p.asset,
      sha256: p.sha256,
      path: p.path,
      durationFrames: p.durationFrames,
    });
  }

  if (issues.length > 0) return { ir: null, issues };

  return {
    ir: {
      ir: "filmbench/render-ir/v1",
      project: state.project.name,
      format: state.project.format,
      totalFrames: totalFrames(state),
      clips,
      requirements: ["ffmpeg", "ffprobe"],
      output: { container: "mp4", videoCodec: "libx264", pixelFormat: "yuv420p", audio: "none" },
    },
    issues: [],
  };
}

const secs = (frames: number, fps: number) => (frames / fps).toFixed(6);

/**
 * 所有输入走同一条 filter_complex：图片先 loop 成静帧，视频按帧数 trim，
 * 统一缩放/补边/fps/像素格式后再 concat。混合来源不需要预先归一化。
 */
export function ffmpegArgs(ir: RenderIR, baseDir: string, out: string): string[] {
  const { width, height, fps } = ir.format;
  const inputs: string[] = [];
  for (const clip of ir.clips) {
    const file = clip.path.startsWith("/") ? clip.path : join(baseDir, clip.path);
    if (clip.kind === "image") inputs.push("-loop", "1", "-t", secs(clip.durationFrames, fps), "-i", file);
    else inputs.push("-i", file);
  }
  const norm = ir.clips
    .map((c, i) => {
      // 一条 filterchain 是 `[in]filter,filter[out]`：标签不是 filter，不能用逗号接
      const chain = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        "setsar=1",
        `fps=${fps}`,
        "format=yuv420p",
        `trim=duration=${secs(c.durationFrames, fps)}`,
        "setpts=PTS-STARTPTS",
      ].join(",");
      return `[${i}:v]${chain}[v${i}]`;
    })
    .join(";");
  const concat = `${ir.clips.map((_, i) => `[v${i}]`).join("")}concat=n=${ir.clips.length}:v=1:a=0[v]`;
  return [
    "-y",
    ...inputs,
    "-filter_complex",
    `${norm};${concat}`,
    "-map",
    "[v]",
    "-c:v",
    ir.output.videoCodec,
    "-pix_fmt",
    ir.output.pixelFormat,
    "-r",
    String(fps),
    "-an",
    "-movflags",
    "+faststart",
    out,
  ];
}

export interface BuildResult {
  ir: RenderIR;
  out: string;
  durationFrames: number;
  sha256: string;
  bytes: number;
}

/** 出片：写 IR → 调 ffmpeg → 记 render.completed。失败不留半成品。 */
export async function build(
  service: Service,
  options: { out?: string; irOnly?: boolean; force?: boolean } = {},
): Promise<BuildResult> {
  const state = service.state();
  const { ir, issues } = compile(state, service.dir, { allowStale: Boolean(options.force) });
  if (!ir) {
    throw new ValidationError(`无法编译：\n${issues.map((i) => `  - [${i.code}] ${i.shot ?? "-"} ${i.detail}`).join("\n")}`);
  }

  const out = options.out ?? join(service.dir, PATHS.build, "final.mp4");
  const buildDir = join(service.dir, PATHS.build);
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "render.ir.json"), `${JSON.stringify(ir, null, 2)}\n`);

  if (options.irOnly) return { ir, out, durationFrames: ir.totalFrames, sha256: "", bytes: 0 };

  service.append("render.requested", {
    irHash: createHash("sha256").update(JSON.stringify(ir)).digest("hex"),
    out,
  });

  const proc = Bun.spawn(["ffmpeg", ...ffmpegArgs(ir, service.dir, out)], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) throw new Error(`ffmpeg 失败（${code}）：${stderr.split("\n").slice(-10).join("\n")}`);

  const bytes = statSync(out).size;
  const digest = createHash("sha256").update(readFileSync(out)).digest("hex");
  service.append("render.completed", { out, sha256: digest, bytes, durationFrames: ir.totalFrames });
  return { ir, out, durationFrames: ir.totalFrames, sha256: digest, bytes };
}
