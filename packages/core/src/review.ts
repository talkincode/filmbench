import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShotState } from "./state.ts";
import { PATHS, ValidationError, type Actor, type Service } from "./service.ts";

/**
 * 分镜审片：把一镜抽成 9 宫格，先用机器能判的规则过一遍，
 * 再交给人和 agent 看那一张图——发现问题就写进事件日志，然后改提示词重拍。
 *
 * 机器判的只有"能测的"：黑帧、冻结、发灰、背景不动（画面分成 3×3 区域看运动分布）。
 * "凿子直插石头""旗幡上有伪汉字"这种要靠看图，所以这里把图摆好、把帧号标在 JSON 里，
 * 由人/agent 补 findings，仍然落同一条事件日志。
 */

export type FindingSeverity = "error" | "warn" | "info";

export interface ReviewFinding {
  code: string;
  severity: FindingSeverity;
  detail: string;
  frame?: number;
}

export interface ReviewSample {
  /** 产物文件里的帧号 */
  frame: number;
  /** 镜头内的时间（秒，从镜头起点算） */
  timeSec: number;
  /** 在成片时间轴上的绝对帧号（含镜头起点） */
  filmFrame: number;
}

export interface ShotReview {
  shot: string;
  asset: string;
  grid: string;
  /** 兼容旧字段：产物里的帧号 */
  frames: number[];
  samples: ReviewSample[];
  width: number;
  height: number;
  findings: ReviewFinding[];
  ok: boolean;
  metrics: {
    meanLuma: number;
    /** 画面内部的对比度（每帧标准差取平均）——低就"发灰" */
    contrast: number;
    /** 整段亮度随时间的波动——低就"没有起伏" */
    lumaSpread: number;
    /** 相邻帧平均差（0–255），越小越像静止 */
    motion: number;
    /** 九个区域里"基本没动"的比例 */
    staticRegions: number;
  };
}

const GRID = 3;
const SAMPLE = GRID * GRID;

const readGray = (file: string, w: number, h: number, count: number): Buffer => {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", `scale=${w}:${h},format=gray`, "-frames:v", String(count), "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`抽帧失败：${r.stderr.toString().slice(-300)}`);
  return r.stdout;
};

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

/**
 * 抽 N 帧 + 拼 3×3。
 *
 * 采样按**镜头时长**切分，不是按固定帧间隔：镜头声明多长，就把它等分成 9 段、每段取中点。
 * 于是九个格子对任何镜头都读作"开头 / 1/8 / 2/8 … / 结尾"，不同长度的镜头可以直接对比；
 * 同时把每个格子在成片里的绝对帧号记下来（filmFrame），跟剪辑点对得上。
 */
export function buildGrid(
  service: Service,
  shot: ShotState,
  out: string,
  size = 480,
): { frames: number[]; samples: ReviewSample[]; path: string } {
  const produce = shot.produce;
  if (!produce) throw new ValidationError(`${shot.id} 还没有产物，先跑作业`);
  const file = join(service.dir, produce.path);
  if (!existsSync(file)) throw new ValidationError(`产物文件不存在: ${produce.path}`);

  const fps = service.state().project?.format.fps ?? 24;
  // 镜头在成片里的起点：只累加画面镜头，音轨不占时间
  let filmStart = 0;
  for (const s of service.state().shots) {
    if (s.id === shot.id) break;
    if ((s.role ?? "picture") === "picture") filmStart += s.durationFrames;
  }
  // 采样范围以"镜头声明时长"为准；产物更长就只用前段，更短就夹到文件末尾
  const declared = shot.durationFrames;
  const available = produce.durationFrames || declared;
  const span = Math.min(declared, available);
  const samples: ReviewSample[] = [];
  for (let i = 0; i < SAMPLE; i++) {
    // 第 i 段的中点：0.5/9, 1.5/9 … 8.5/9
    const t = ((i + 0.5) / SAMPLE) * span;
    const frame = Math.min(available - 1, Math.max(0, Math.round(t)));
    samples.push({
      frame,
      timeSec: Number((frame / fps).toFixed(3)),
      filmFrame: filmStart + Math.min(declared - 1, Math.max(0, Math.round(t))),
    });
  }
  const frames = samples.map((s) => s.frame);
  const select = frames.map((f) => `eq(n\,${f})`).join("+");
  mkdirSync(join(service.dir, PATHS.build, "reviews"), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", file, "-vf", `select='${select}',scale=${size}:-1,tile=${GRID}x${GRID}`, "-frames:v", "1", out],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`九宫格拼图失败：${r.stderr.toString().slice(-300)}`);
  return { frames, samples, path: out };
}

/** 只跑机器能判的规则；看图得出的结论由调用方追加。 */
export function analyze(service: Service, shot: ShotState): Pick<ShotReview, "metrics" | "findings"> {
  const produce = shot.produce!;
  const file = join(service.dir, produce.path);
  if (produce.kind !== "video") {
    return {
      metrics: { meanLuma: 0, contrast: 0, lumaSpread: 0, motion: 0, staticRegions: 0 },
      findings: [{ code: "not-video", severity: "info", detail: "静帧产物，只看图，不做运动分析" }],
    };
  }
  const W = 96;
  const H = 54;
  const total = produce.durationFrames || shot.durationFrames;
  const raw = readGray(file, W, H, total);
  const frameSize = W * H;
  const count = Math.floor(raw.length / frameSize);
  if (count < 2) throw new Error("产物帧数不足，无法审片");

  const lumas: number[] = [];
  const diffs: number[] = [];
  const regionMotion = new Array(GRID * GRID).fill(0);
  const regionCount = new Array(GRID * GRID).fill(0);
  let prev = raw.subarray(0, frameSize);
  for (let f = 0; f < count; f++) {
    const cur = raw.subarray(f * frameSize, (f + 1) * frameSize);
    let sum = 0;
    for (let i = 0; i < frameSize; i++) sum += cur[i];
    lumas.push(sum / frameSize);
    if (f > 0) {
      let acc = 0;
      for (let y = 0; y < H; y++) {
        const ry = Math.min(GRID - 1, Math.floor((y / H) * GRID));
        for (let x = 0; x < W; x++) {
          const d = Math.abs(cur[y * W + x] - prev[y * W + x]);
          acc += d;
          const rx = Math.min(GRID - 1, Math.floor((x / W) * GRID));
          const idx = ry * GRID + rx;
          regionMotion[idx] += d;
          regionCount[idx] += 1;
        }
      }
      diffs.push(acc / frameSize);
    }
    prev = cur;
  }
  const perRegion = regionMotion.map((v, i) => v / Math.max(1, regionCount[i]));
  const maxRegion = Math.max(...perRegion);

  const findings: ReviewFinding[] = [];
  const meanLuma = mean(lumas);
  const lumaSpread = std(lumas);

  // 画面内部对比度：每帧自己的标准差，再取平均（不是帧间亮度波动）
  const frameContrast = (f: number) => {
    const cur = raw.subarray(f * frameSize, (f + 1) * frameSize);
    const vals = Array.from(cur);
    return std(vals);
  };
  const contrast = mean(Array.from({ length: count }, (_, f) => frameContrast(f)));

  // 设计类产物（片名卡 / 图纸卡）本来就接近静止，冻结只报 info
  const design = ["filmbench/title", "filmbench/hyperframes", "filmbench/colorcard"].includes(shot.binder.provider);

  // 黑场：整段亮度都极低
  if (meanLuma < 8) findings.push({ code: "black", severity: "error", detail: `整段平均亮度 ${meanLuma.toFixed(1)}，几乎是黑帧` });

  // 冻结：连续 0.5 秒几乎没有变化
  const fps = 24;
  const win = Math.max(6, Math.round(fps * 0.5));
  let frozenRun = 0;
  let frozenAt = -1;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i] < 0.35) {
      frozenRun += 1;
      if (frozenRun >= win && frozenAt < 0) frozenAt = i - win + 1;
    } else {
      frozenRun = 0;
    }
  }
  if (frozenAt >= 0) {
    findings.push({
      code: "freeze",
      severity: design ? "info" : "error",
      detail: `第 ${frozenAt} 帧起连续 ${win} 帧几乎无变化${design ? "（设计类产物，允许静止）" : ""}`,
      frame: frozenAt,
    });
  }

  // 发灰：画面内部对比度低（雾天确实会低，所以只报 warn）
  if (contrast < 28 && !design) {
    findings.push({ code: "flat", severity: "warn", detail: `画面内部对比度只有 ${contrast.toFixed(1)}，看着发灰` });
  }
  // 没有起伏：整段亮度几乎不变
  if (lumaSpread < 2 && !design) findings.push({ code: "no-arc", severity: "info", detail: `整段亮度波动只有 ${lumaSpread.toFixed(1)}，缺少明暗起伏` });

  // 背景静止：九个区域里至少 6 个几乎不动，只有 1–2 个在动 → 很像"图层拼合"
  const staticRegions = perRegion.filter((v) => v < Math.max(0.5, maxRegion * 0.15)).length;
  if (staticRegions >= 6 && maxRegion > 0.8) {
    findings.push({
      code: "static-background",
      severity: "warn",
      detail: `${staticRegions}/9 个区域几乎不动，只有局部在动（前景在演、背景是贴图）`,
    });
  }

  return { metrics: { meanLuma, contrast, lumaSpread, motion: mean(diffs), staticRegions }, findings };
}

export function reviewShot(
  service: Service,
  shotId: string,
  options: { extraFindings?: { code: string; severity: FindingSeverity; detail: string }[]; note?: string } = {},
): ShotReview {
  const state = service.state();
  const shot = state.shots.find((s) => s.id === shotId);
  if (!shot) throw new ValidationError(`镜头不存在: ${shotId}`);
  if (!shot.produce) throw new ValidationError(`${shotId} 还没有产物`);
  const gridPath = join(PATHS.build, "reviews", `${shot.id}-grid.png`);
  const { frames, samples } = buildGrid(service, shot, join(service.dir, gridPath));
  const { metrics, findings } = analyze(service, shot);
  const all = [...findings, ...(options.extraFindings ?? [])];
  return {
    shot: shot.id,
    asset: shot.produce.asset,
    grid: gridPath,
    frames,
    samples,
    width: shot.produce.width,
    height: shot.produce.height,
    metrics,
    findings: all,
    ok: !all.some((f) => f.severity === "error"),
  };
}

/** 把审片结论写进事件日志（谁看的、看到什么、要不要重拍） */
export function recordReview(
  service: Service,
  review: ShotReview,
  actor: Actor,
  note?: string,
): number {
  const { event } = service.append(
    "shot.reviewed",
    {
      shot: review.shot,
      asset: review.asset,
      grid: review.grid,
      frames: review.frames,
      findings: review.findings,
      metrics: review.metrics,
      note: note ?? "",
    },
    { actor },
  );
  return event.seq;
}
