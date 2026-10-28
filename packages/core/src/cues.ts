import { readFileSync } from "node:fs";
import type { ProjectState } from "./state.ts";
import { pictureShots } from "./state.ts";

/**
 * 中立卡点文件 filmbench/cues-v1：只声明"音乐在第几小节换段"，
 * 时间由 tempo × 拍号算出来，和任何一家音乐工具无关。
 */
export interface CuesFile {
  apiVersion: "filmbench/cues-v1";
  kind: "Cues";
  tempo: number;
  beatsPerBar: number;
  cues: { bar: number; label?: string }[];
}

export interface CuePoint {
  t: number;
  label: string;
}

export function parseCues(raw: unknown): CuesFile {
  const d = raw as Partial<CuesFile>;
  if (d.apiVersion !== "filmbench/cues-v1" || d.kind !== "Cues") {
    throw new Error("卡点文件必须是 filmbench/cues-v1（kind: Cues）");
  }
  if (!Number.isFinite(d.tempo) || (d.tempo ?? 0) <= 0) throw new Error("tempo 必须是正数");
  if (!Number.isInteger(d.beatsPerBar) || (d.beatsPerBar ?? 0) <= 0) throw new Error("beatsPerBar 必须是正整数");
  if (!Array.isArray(d.cues) || d.cues.length === 0) throw new Error("cues 不能为空");
  for (const c of d.cues) if (!Number.isInteger(c.bar) || c.bar < 0) throw new Error("cues[].bar 必须是非负整数");
  return d as CuesFile;
}

export function loadCues(path: string): CuesFile {
  return parseCues(JSON.parse(readFileSync(path, "utf8")));
}

/** 小节号 → 秒 */
export function cueTimes(file: CuesFile): CuePoint[] {
  const secPerBar = (file.beatsPerBar * 60) / file.tempo;
  return file.cues.map((c) => ({ t: c.bar * secPerBar, label: c.label ?? `bar ${c.bar}` }));
}

/** 画面镜头的剪辑点（秒），从 0 开始累加；不含音乐镜头 */
export function cutPoints(state: ProjectState): number[] {
  const fps = state.project?.format.fps ?? 30;
  let cursor = 0;
  const points: number[] = [0];
  for (const shot of pictureShots(state)) {
    cursor += shot.durationFrames;
    points.push(cursor / fps);
  }
  return points;
}

export interface CueRow {
  cut: number;
  cue: number | null;
  label: string | null;
  delta: number;
  ok: boolean;
}

/** 每个剪辑点都必须落在某个音乐段落边界上（容差内），否则算没卡上 */
export function alignCues(state: ProjectState, cues: CuePoint[], toleranceSec: number): CueRow[] {
  return cutPoints(state).map((cut) => {
    let best: CuePoint | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const c of cues) {
      const d = Math.abs(c.t - cut);
      if (d < bestDelta) {
        bestDelta = d;
        best = c;
      }
    }
    return {
      cut,
      cue: best?.t ?? null,
      label: best?.label ?? null,
      delta: Number((best ? best.t - cut : NaN).toFixed(3)),
      ok: Boolean(best) && bestDelta <= toleranceSec + 1e-9,
    };
  });
}
