import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Format } from "@filmbench/protocol";
import { PATHS, ValidationError, type Service } from "./service.ts";
import { pictureShots, totalFrames, type ProjectState } from "./state.ts";
import { shotStale } from "./stale.ts";
import { alignCues, cueTimes, loadCues } from "./cues.ts";
import { narrationSrt, voiceAlignment } from "./narration.ts";

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
  audio: {
    shot: string;
    role: "music" | "voice";
    path: string;
    startFrame: number;
    durationFrames: number;
    volume: number;
    fadeInFrames: number;
    fadeOutFrames: number;
    /** 已经做过母带的音轨（normalize:false）不再跑一遍 loudnorm：那会把力度曲线压平 */
    normalize: boolean;
    /** 旁白避让：enabled=false 就完全不做 sidechain（旁白铺满全片时静态让位更自然） */
    duck: { enabled: boolean; threshold: number; ratio: number; attackMs: number; releaseMs: number };
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
  const { format } = state.project;
  if (pictureShots(state).length === 0) issues.push({ code: "no-shots", detail: "没有任何画面镜头" });

  const clips: RenderIR["clips"] = [];
  const audio: RenderIR["audio"] = [];

  for (const shot of state.shots) {
    if ((shot.role ?? "picture") !== "picture") {
      if (!shot.produce) {
        issues.push({ code: "missing-output", shot: shot.id, detail: "音轨没有产物" });
        continue;
      }
      const file = join(baseDir, shot.produce.path);
      if (!existsSync(file)) {
        issues.push({ code: "asset-file-missing", shot: shot.id, detail: `音频不存在: ${shot.produce.path}` });
        continue;
      }
      if (shot.binder.params.fit === "exact") {
        const cuesPath = String(shot.binder.params.cues ?? "");
        if (!cuesPath) {
          issues.push({ code: "cues-misaligned", shot: shot.id, detail: "fit: exact 需要 params.cues（filmbench/cues-v1）" });
        } else {
          try {
            const cues = cueTimes(loadCues(join(baseDir, cuesPath)));
            const tolerance = Number(shot.binder.params.tolerance ?? 0.06);
            const rows = alignCues(state, cues, tolerance);
            const bad = rows.filter((r) => !r.ok);
            if (bad.length) {
              issues.push({
                code: "cues-misaligned",
                shot: shot.id,
                detail: `${bad.length}/${rows.length} 个剪辑点没卡上（容差 ${tolerance}s）：${bad
                  .slice(0, 3)
                  .map((r) => `${r.cut.toFixed(2)}s→${r.cue?.toFixed(2) ?? "-"}s Δ${r.delta.toFixed(2)}`)
                  .join("，")}`,
              });
            }
          } catch (e) {
            issues.push({ code: "cues-misaligned", shot: shot.id, detail: (e as Error).message });
          }
        }
      }
      const isVoice = shot.role === "voice";
      const fadeIn = Number(shot.binder.params.fadeIn ?? (isVoice ? 0 : 1.5));
      const fadeOut = Number(shot.binder.params.fadeOut ?? (isVoice ? 0.15 : 2));
      audio.push({
        shot: shot.id,
        role: isVoice ? "voice" : "music",
        path: shot.produce.path,
        startFrame: Number(shot.binder.params.startFrame ?? 0),
        durationFrames: shot.produce.durationFrames,
        volume: Number(shot.binder.params.volume ?? (isVoice ? 1 : 0.55)),
        fadeInFrames: Math.round(fadeIn * format.fps),
        fadeOutFrames: Math.round(fadeOut * format.fps),
        normalize: shot.binder.params.normalize !== false,
        duck: {
          enabled: shot.binder.params.duck !== false,
          threshold: Number(shot.binder.params.duckThreshold ?? 0.05),
          ratio: Number(shot.binder.params.duckRatio ?? 2.5),
          attackMs: Number(shot.binder.params.duckAttack ?? 40),
          releaseMs: Number(shot.binder.params.duckRelease ?? 800),
        },
      });
      continue;
    }

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

  for (const line of voiceAlignment(state)) {
    if (!line.ok) {
      issues.push({
        code: "voice-misaligned",
        shot: line.shot,
        detail: `旁白入点 ${line.start.toFixed(2)}s 没有落在剪辑点（最近 ${line.cut?.toFixed(2) ?? "-"}s）`,
      });
    }
  }

  if (issues.length > 0) return { ir: null, issues };

  return {
    ir: {
      ir: "filmbench/render-ir/v1",
      project: state.project.name,
      format: state.project.format,
      totalFrames: totalFrames(state),
      clips,
      audio,
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
  for (const track of ir.audio) {
    inputs.push("-i", track.path.startsWith("/") ? track.path : join(baseDir, track.path));
  }

  const norm = ir.clips
    .map((c, i) => {
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

  const durationSec = ir.totalFrames / fps;
  const audioChains = ir.audio.map((track, i) => {
    const parts: string[] = [];
    // 旁白比音乐床更靠前：-16 LUFS；音乐 -18 LUFS
    // 动态归一化会重排力度关系（轻的地方被抬起来，顶点被压下去）。配乐要保曲线，
    // 就在 provider 里做好母带、这里 normalize:false；linear=true 只做整段增益。
    if (track.normalize) {
      parts.push(
        track.role === "voice"
          ? "loudnorm=I=-16:TP=-1.5:LRA=7:linear=true"
          : "loudnorm=I=-18:TP=-2:LRA=11:linear=true",
      );
    } else {
      parts.push("alimiter=limit=0.95:level=false:attack=3:release=80");
    }
    parts.push(`volume=${track.volume}`);
    if (track.fadeInFrames > 0) parts.push(`afade=t=in:st=0:d=${secs(track.fadeInFrames, fps)}`);
    if (track.fadeOutFrames > 0) {
      const anchor = track.role === "music" ? durationSec : track.durationFrames / fps;
      const start = Math.max(0, anchor - track.fadeOutFrames / fps);
      parts.push(`afade=t=out:st=${start.toFixed(3)}:d=${secs(track.fadeOutFrames, fps)}`);
    }
    if (track.startFrame > 0) {
      const ms = Math.round((track.startFrame / fps) * 1000);
      parts.push(`adelay=${ms}|${ms}`);
    }
    return `[${ir.clips.length + i}:a]${parts.join(",")}[a${i}]`;
  });
  // 有旁白时让音乐自动避让（sidechain），否则直接把所有音轨相加
  const voiceIdx = ir.audio.map((t, i) => (t.role === "voice" ? i : -1)).filter((i) => i >= 0);
  const musicIdx = ir.audio.map((t, i) => (t.role === "music" ? i : -1)).filter((i) => i >= 0);
  const duck: string[] = [];
  let mix: string | null = null;

  const duckedMusic = musicIdx.filter((i) => ir.audio[i].duck.enabled);
  if (ir.audio.length === 0) {
    mix = null;
  } else if (voiceIdx.length > 0 && duckedMusic.length > 0) {
    const voiceLabels = voiceIdx.map((i) => `[a${i}]`).join("");
    // 每条音乐轨都要一个 sidechain 输入：asplit 的份数 = 1（混音）+ 音乐轨数，
    // 两条音乐轨却只 asplit=2 时，第二路会复用同一个 [vsc]，ffmpeg 直接报 "
    // Error binding filtergraph inputs/outputs"
    const vscCount = duckedMusic.length;
    const vscLabels = ir.audio.map((_, i) => `[vsc${i}]`);
    duck.push(
      `${voiceLabels}amix=inputs=${voiceIdx.length}:duration=longest:dropout_transition=0:normalize=0,` +
        `apad=whole_dur=${durationSec.toFixed(3)},asplit=${vscCount + 1}[vmix]${vscLabels.join("")}`,
    );
    const ducked = duckedMusic.map((i, k) => {
      const d = ir.audio[i].duck;
      // 慢起慢落：默认 attack 40ms / release 800ms / ratio 2.5，
      // 原来 15ms/350ms/6 会跟着每个字抽气，听着像音乐在"喘"
      duck.push(
        `[a${i}]${vscLabels[k]}sidechaincompress=threshold=${d.threshold}:ratio=${d.ratio}` +
          `:attack=${d.attackMs}:release=${d.releaseMs}[duck${i}]`,
      );
      return `[duck${i}]`;
    });
    // 没有参与避让的音乐轨（duck:false）直接跟人声相加，不再过 sidechain
    const plain = musicIdx
      .filter((i) => !duckedMusic.includes(i))
      .map((i) => `[a${i}]`)
      .join("");
    mix = `${ducked.join("")}${plain}[vmix]amix=inputs=${duckedMusic.length + (plain ? 1 : 0) + 1}:duration=longest:dropout_transition=0:normalize=0[a]`;
  } else if (ir.audio.length === 1) {
    mix = "[a0]anull[a]";
  } else {
    mix = `${ir.audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${ir.audio.length}:duration=longest:dropout_transition=0:normalize=0[a]`;
  }

  // 多轨相加会顶到 0 dBFS：总线后面挂一个限幅器，别让编码前的峰值越界
  const master = mix ? `${mix.replace(/\[a\]$/, "[apre]")};[apre]alimiter=limit=0.7:level=false:attack=5:release=120[a]` : null;
  const graph = [norm, concat, ...audioChains, ...duck, ...(master ? [master] : [])].join(";");
  return [
    "-y",
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    ...(mix ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : ["-an"]),
    "-c:v",
    ir.output.videoCodec,
    "-pix_fmt",
    ir.output.pixelFormat,
    "-r",
    String(fps),
    "-t",
    durationSec.toFixed(3),
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
  const srt = narrationSrt(state);
  if (srt.trim()) writeFileSync(join(service.dir, PATHS.build, "narration.srt"), srt);

  service.append("render.completed", { out, sha256: digest, bytes, durationFrames: ir.totalFrames });
  return { ir, out, durationFrames: ir.totalFrames, sha256: digest, bytes };
}
