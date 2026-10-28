import type { ProjectState, ShotState } from "./state.ts";
import { hashReferencedFiles, inputsHash } from "./jobs.ts";

/**
 * 过期判定不再看"改过没有"，而看"输入是否变了"：
 * 产物作业记录的 inputsHash 与当前镜头（含生效 prompt、参考、参数）算出来的不一致，才算过期。
 * 这样重写同样的 prompt、只改 fallback 文本都不会误判。
 */
export function shotStale(state: ProjectState, shot: ShotState): boolean {
  if (!shot.produce) return false;
  const job = state.jobs.get(shot.produce.jobId);
  if (!job) return shot.mutatedAt > shot.produce.atSeq;
  // 老作业（没有版本号）沿用时间戳判定，避免算法迭代把历史产物全部判成过期
  if (job.inputsVersion === undefined) return shot.mutatedAt > shot.produce.atSeq;
  // 用作业当时记录的 provider 模态；老作业没有该字段时退回产物类型
  const modality = job.modality === undefined ? shot.produce.kind : job.modality;
  const fps = state.project?.format.fps ?? 30;
  // 图片产物的时长不参与生成，历史上算过含时长与不含时长两种哈希，两种都认
  const files = hashReferencedFiles(state.dir ?? process.cwd(), shot.binder.params);
  const variants: boolean[] = modality === "image" ? [false, true] : [true];
  const candidates = variants.flatMap((includeDuration) =>
    [false, true].map((includeMix) =>
      inputsHash(shot, fps, shot.binder.params, modality, includeDuration, files, includeMix),
    ),
  );
  return !candidates.includes(job.inputsHash);
}
