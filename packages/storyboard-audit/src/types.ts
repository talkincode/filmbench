/**
 * filmbench 审计故事板投影（storyboard-audit/v1）
 *
 * 输入是编译侧与设计侧的只读投影，不是真相：真相在 journal。
 * 本工具只做聚合、审计判定与渲染，不写回任何状态，输出是确定性的单文件 HTML。
 */

export type Severity = "blocker" | "warning" | "note";
export type CheckStatus = "pass" | "fail" | "warn" | "unknown";

export interface Check {
  id: string;
  status: CheckStatus;
  detail?: string;
}

export interface MediaRef {
  kind: "image" | "video" | "audio" | "archive";
  asset?: string;
  role?: string;
  approved?: boolean;
}

export interface SubjectPin {
  id: string;
  name: string;
  revision: number;
  variant?: string;
  approved?: boolean;
}

export interface Produce {
  kind: "image" | "video" | "audio" | "subtitle";
  path: string;
  exists: boolean;
  stale?: boolean;
  sha256?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationFrames?: number;
  /** 预览图：绝对路径（渲染前会被改写成相对 URL 或 data URI） */
  preview?: string | null;
  previewSeed?: string;
}

export interface Candidate {
  asset: string;
  actor?: string;
  review?: "candidate" | "selected" | "rejected" | "unreviewed";
}

export interface Dependency {
  shot: string;
  kind: "continuity" | "last_frame" | "data" | "derived";
}

export interface Cost {
  currency?: string;
  estimated?: number;
  actual?: number;
  cu?: number;
  priceUnknown?: boolean;
}

export interface Shot {
  id: string;
  title: string;
  durationFrames: number;
  intent: { description?: string; action?: string; prompt?: string };
  binder: { provider: string; task: string; params?: Record<string, string | number | boolean> };
  subjects?: SubjectPin[];
  references?: MediaRef[];
  candidates?: Candidate[];
  selected?: { video?: string | null; image?: string | null; audio?: string | null };
  produces?: Produce[];
  dependsOn?: Dependency[];
  checks?: Check[];
  cost?: Cost;
  provenance?: { revisionSeq?: number; approvedBy?: string; proposal?: string };
}

export interface AudioTrack {
  id: string;
  role: "bgm" | "voiceover" | "ambience" | "sfx";
  asset: string;
  startFrame: number;
  durationFrames: number;
  trimStartFrame?: number;
  approved?: boolean;
}

export interface StoryboardDoc {
  apiVersion: "filmbench/storyboard-audit/v1";
  project: {
    name: string;
    title: string;
    fps: number;
    output: { width: number; height: number; durationFrames?: number; container?: string };
    budget?: { currency: string; limit: number };
  };
  revision: { ref: string; seq: number; hash: string };
  shots: Shot[];
  audioTracks?: AudioTrack[];
  provenance?: { engine?: string; irHash?: string; lockHash?: string };
}

/** 派生态：渲染直接消费，避免模板里再算 */
export interface DerivedShot extends Shot {
  order: number;
  seconds: number;
  state: "ready" | "stale" | "missing" | "blocked";
  findings: Finding[];
  selectedApproved: boolean;
  hasPreview: boolean;
  /** 与 state 正交：一个阻塞镜头可能同时缺产物，统计要分开数 */
  missingArtifact: boolean;
  staleArtifact: boolean;
  blocked: boolean;
}

export interface Finding {
  check: string;
  severity: Severity;
  label: string;
  action: string;
  shot?: string;
  detail?: string;
}

export interface Totals {
  shots: number;
  missingArtifact: number;
  flaggedStale: number;
  frames: number;
  seconds: number;
  ready: number;
  stale: number;
  missing: number;
  blocked: number;
  blockers: number;
  warnings: number;
  notes: number;
  costEstimated: number;
  costActual: number;
  cu: number;
  currency: string;
  unknownPriceShots: number;
  audioFrames: number;
}
