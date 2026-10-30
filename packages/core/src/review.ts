import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    /** 中心区（主体所在）的运动量 */
    centerMotion: number;
    /** 运动最多的两个区域占总运动的比例——高就说明只有局部在动 */
    top2Share: number;
    /** 与参考控制视频的运动包络相关系数（没接 controlnet 时缺省） */
    controlFollow?: number;
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

/**
 * 新旧对比图：上一版产物 vs 当前产物，各取首/中/尾三帧，上下两行拼一张。
 * 重拍之后想知道"到底好没好"，光看九宫格不够——得并排看同一时刻。
 */
export function buildCompare(service: Service, shot: ShotState, out: string, size = 520): { previous: string; current: string; path: string } | null {
  const state = service.state();
  const current = shot.produce;
  if (!current) throw new ValidationError(`${shot.id} 还没有产物`);
  const previous = [...state.jobs.values()]
    .filter((j) => j.shot === shot.id && j.produce && j.produce.asset !== current.asset)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .pop()?.produce;
  if (!previous) return null;

  const pick = (frames: number) => [0.08, 0.5, 0.92].map((t) => Math.round(t * (frames - 1)));
  const grab = (file: string, frames: number, tag: string) => {
    const idx = pick(frames);
    const pngs = idx.map((f) => join(service.dir, PATHS.build, "reviews", `${shot.id}-${tag}-${f}.png`));
    idx.forEach((f, i) => {
      mkdirSync(dirname(pngs[i]), { recursive: true });
      const r = spawnSync(
        "ffmpeg",
        ["-y", "-v", "error", "-i", file, "-vf", `select='eq(n\,${f})',scale=${size}:-1`, "-frames:v", "1", pngs[i]],
        { maxBuffer: 1 << 30 },
      );
      if (r.status !== 0) throw new Error(`抽帧失败：${r.stderr.toString().slice(-200)}`);
    });
    return pngs;
  };

  const prevPath = join(service.dir, previous.path);
  const curPath = join(service.dir, current.path);
  if (!existsSync(prevPath) || !existsSync(curPath)) return null;
  const prevPngs = grab(prevPath, previous.durationFrames || shot.durationFrames, "old");
  const curPngs = grab(curPath, current.durationFrames || shot.durationFrames, "new");
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", ...prevPngs.flatMap((p) => ["-i", p]), ...curPngs.flatMap((p) => ["-i", p]),
      "-filter_complex", `[0:v][1:v][2:v]hstack=inputs=3[top];[3:v][4:v][5:v]hstack=inputs=3[bot];[top][bot]vstack=inputs=2[out]`,
      "-map", "[out]", "-frames:v", "1", out],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`对比图拼接失败：${r.stderr.toString().slice(-200)}`);
  return { previous: previous.asset, current: current.asset, path: out };
}

/** 只跑机器能判的规则；看图得出的结论由调用方追加。 */
export function analyze(service: Service, shot: ShotState): Pick<ShotReview, "metrics" | "findings"> {
  const produce = shot.produce!;
  const file = join(service.dir, produce.path);
  if (produce.kind !== "video") {
    return {
      metrics: { meanLuma: 0, contrast: 0, lumaSpread: 0, motion: 0, staticRegions: 0, centerMotion: 0, top2Share: 0 },
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
  const centerMotion = perRegion[4]; // 3×3 的正中一格
  const sortedRegion = [...perRegion].sort((a, b) => b - a);
  const top2Share = sortedRegion[0] + sortedRegion[1] ? (sortedRegion[0] + sortedRegion[1]) / perRegion.reduce((a, b) => a + b, 0) : 0;
  const dupFrames = diffs.filter((d) => d < 0.05).length;
  const flickers = lumas.filter((v, i) => i > 0 && Math.abs(v - lumas[i - 1]) > 6).length;

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

  // 主体静止：四周在动（火把/雾/水），正中那一格不动——人像被定住
  if (!design && centerMotion < Math.max(0.25, maxRegion * 0.18) && maxRegion > 0.6) {
    findings.push({
      code: "subject-static",
      severity: "error",
      detail: `中心区运动 ${centerMotion.toFixed(2)}，最活跃区 ${maxRegion.toFixed(2)}：动的是边上，主体几乎定住`,
    });
  }

  // 运动集中在局部：最多的两格吃掉 85% 以上的运动
  if (!design && top2Share > 0.85 && maxRegion > 0.5 && perRegion.reduce((a, b) => a + b, 0) > 1) {
    findings.push({
      code: "motion-concentration",
      severity: "warn",
      detail: `运动集中在 2/9 个区域（占 ${(top2Share * 100).toFixed(0)}%），其余区域几乎不动`,
    });
  }

  // 重复帧：连续两帧几乎一模一样，超过 15% 就是在"卡帧"
  if (!design && diffs.length > 10 && dupFrames / diffs.length > 0.15) {
    findings.push({
      code: "duplicate-frames",
      severity: "warn",
      detail: `${((dupFrames / diffs.length) * 100).toFixed(0)}% 的相邻帧几乎相同，镜头会顿`,
    });
  }

  // 闪烁：亮度逐帧跳变超过 6 的次数
  if (!design && flickers > 4) {
    findings.push({ code: "flicker", severity: "warn", detail: `有 ${flickers} 次亮度跳变（>6），曝光不稳` });
  }

  // 背景静止：九个区域里至少 6 个几乎不动，只有 1–2 个在动 → 很像"图层拼合"
  const staticRegions = perRegion.filter((v) => v < Math.max(0.5, maxRegion * 0.15)).length;
  if (staticRegions >= 6 && maxRegion > 0.8) {
    findings.push({
      code: "static-background",
      severity: "warn",
      detail: `${staticRegions}/9 个区域几乎不动，只有局部在动（前景在演、背景是贴图）`,
    });
  }

  return {
    metrics: { meanLuma, contrast, lumaSpread, motion: mean(diffs), staticRegions, centerMotion, top2Share },
    findings,
  };
}

/** 3×3 区域运动向量：控制与成片"哪个区域在动"是否一致，比时间包络更能说明构图是否被约束 */
function regionVector(file: string, frames: number, W = 96, H = 54): number[] | null {
  const raw = readGray(file, W, H, frames);
  const size = W * H;
  const count = Math.floor(raw.length / size);
  if (count < 3) return null;
  const acc = new Array(GRID * GRID).fill(0);
  const cnt = new Array(GRID * GRID).fill(0);
  for (let f = 1; f < count; f++) {
    for (let y = 0; y < H; y++) {
      const ry = Math.min(GRID - 1, Math.floor((y / H) * GRID));
      for (let x = 0; x < W; x++) {
        const d = Math.abs(raw[f * size + y * W + x] - raw[(f - 1) * size + y * W + x]);
        const idx = ry * GRID + Math.min(GRID - 1, Math.floor((x / W) * GRID));
        acc[idx] += d;
        cnt[idx] += 1;
      }
    }
  }
  return acc.map((v, i) => v / Math.max(1, cnt[i]));
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : NaN;
};

/** 接了什么控制视频，就核对成片的运动分布是不是跟着它走 */
function controlFollow(service: Service, shot: ShotState, outputFile: string, frames: number): number | null {
  const rel = shot.binder.params?.controlVideo;
  if (typeof rel !== "string" || !rel) return null;
  const file = rel.startsWith("/") ? rel : join(service.dir, rel);
  if (!existsSync(file)) return null;
  const control = regionVector(file, frames);
  const out = regionVector(outputFile, frames);
  if (!control || !out) return null;
  const corr = cosine(control, out);
  return Number.isFinite(corr) ? Number(corr.toFixed(3)) : null;
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
  // 控制视频的"跟随度"：成片动得和控制要求的是不是一回事
  const corr = controlFollow(service, shot, join(service.dir, shot.produce!.path), shot.produce!.durationFrames || shot.durationFrames);
  if (corr !== null) {
    metrics.controlFollow = corr;
    if (corr < 0.3) {
      findings.push({
        code: "control-not-followed",
        severity: "error",
        detail: `成片的运动分布与控制视频只有 ${corr} 的相似度：构图基本没被约束住，检查 strength / end 或控制视频`,
      });
    } else if (corr < 0.5) {
      findings.push({
        code: "control-weak",
        severity: "warn",
        detail: `成片与控制的运动分布相似度 ${corr} 偏低：控制只在局部起作用`,
      });
    }
  }
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
