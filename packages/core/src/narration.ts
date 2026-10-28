import type { ProjectState } from "./state.ts";
import { pictureShots } from "./state.ts";

export interface VoiceLine {
  shot: string;
  text: string;
  startFrame: number;
  durationFrames: number;
  volume: number;
}

export function voiceLines(state: ProjectState): VoiceLine[] {
  return state.shots
    .filter((s) => (s.role ?? "picture") === "voice" && s.produce)
    .map((s) => ({
      shot: s.id,
      text: s.intent.narration ?? "",
      startFrame: Number(s.binder.params.startFrame ?? 0),
      durationFrames: s.produce!.durationFrames,
      volume: Number(s.binder.params.volume ?? 1),
    }));
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ts = (frames: number, fps: number) => {
  const total = frames / fps;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
};

/** 把旁白按句子切分，按字数比例分配到音频时长上（近似，不是强制对齐） */
export function narrationSrt(state: ProjectState): string {
  const fps = state.project?.format.fps ?? 30;
  const lines = voiceLines(state);
  const cues: string[] = [];
  let index = 1;
  for (const line of lines) {
    const sentences = line.text
      .split(/(?<=[。！？!?])/u)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!sentences.length) continue;
    const totalChars = sentences.reduce((n, s) => n + [...s].length, 0);
    let cursor = line.startFrame;
    for (const sentence of sentences) {
      const frames = Math.max(1, Math.round((line.durationFrames * [...sentence].length) / totalChars));
      cues.push(`${index}\n${ts(cursor, fps)} --> ${ts(Math.min(cursor + frames, line.startFrame + line.durationFrames), fps)}\n${sentence}\n`);
      cursor += frames;
      index++;
    }
  }
  return cues.join("\n");
}

/** 旁白入点必须落在某个剪辑点上（和音乐卡点同一套思路） */
export function voiceAlignment(state: ProjectState, toleranceSec = 0.06): { shot: string; start: number; cut: number | null; ok: boolean }[] {
  const fps = state.project?.format.fps ?? 30;
  let cursor = 0;
  const cuts = [0];
  for (const shot of pictureShots(state)) {
    cursor += shot.durationFrames;
    cuts.push(cursor / fps);
  }
  return voiceLines(state).map((line) => {
    const start = line.startFrame / fps;
    let nearest: number | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const cut of cuts) {
      const d = Math.abs(cut - start);
      if (d < best) {
        best = d;
        nearest = cut;
      }
    }
    return { shot: line.shot, start, cut: nearest, ok: best <= toleranceSec + 1e-9 };
  });
}
