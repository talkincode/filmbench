import type { ProjectState, ShotState } from "./state.ts";
import { inputsHash } from "./jobs.ts";

/**
 * 过期判定不再看"改过没有"，而看"输入是否变了"：
 * 产物作业记录的 inputsHash 与当前镜头（含生效 prompt、参考、参数）算出来的不一致，才算过期。
 * 这样重写同样的 prompt、只改 fallback 文本都不会误判。
 */
export function shotStale(state: ProjectState, shot: ShotState): boolean {
  if (!shot.produce) return false;
  const job = state.jobs.get(shot.produce.jobId);
  if (!job) return shot.mutatedAt > shot.produce.atSeq;
  const current = inputsHash(shot, state.project?.format.fps ?? 30, shot.binder.params, shot.produce.kind);
  return job.inputsHash !== current;
}
