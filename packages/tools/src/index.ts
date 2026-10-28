import { Service, build, compile, projectStoryboard, runJobs, submit, summarize, totalFrames } from "@filmbench/core";
import { builtinProviders } from "@filmbench/providers";

/**
 * 工具表：内置 agent（pi）与 stdio MCP 共用同一份定义。
 * 一个能力只写一次，两个入口各自适配传输层——不允许出现"agent 能做的 MCP 做不到"。
 */
export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown> | unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function toolSpecs(dir: string): ToolSpec[] {
  const registry = builtinProviders();
  const svc = () => Service.open(dir);

  return [
    {
      name: "project_state",
      label: "读取项目状态",
      description: "返回项目、镜头、产物状态、作业队列、预算与编译就绪度。任何写操作前先读它。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const s = svc();
        try {
          const state = s.state();
          const { ir, issues } = compile(state, dir);
          const cost = summarize(state);
          return {
            project: state.project,
            head: state.head,
            shots: state.shots.map((shot) => ({
              id: shot.id,
              title: shot.title,
              durationFrames: shot.durationFrames,
              provider: shot.binder.provider,
              task: shot.binder.task,
              hasOutput: Boolean(shot.produce),
              stale: shot.produce ? shot.mutatedAt > shot.produce.atSeq : false,
              dependsOn: shot.dependsOn,
            })),
            jobs: [...state.jobs.values()].map((j) => ({ jobId: j.jobId, shot: j.shot, phase: j.phase, reason: j.reason })),
            cost,
            renderable: Boolean(ir),
            issues,
            totalFrames: totalFrames(state),
          };
        } finally {
          s.close();
        }
      },
    },
    {
      name: "shot_add",
      label: "新增镜头",
      description: "新增一个镜头（意图 + provider 绑定 + 时长帧）。id 稳定且不可复用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          durationFrames: { type: "number" },
          provider: { type: "string" },
          task: { type: "string" },
          prompt: { type: "string" },
          description: { type: "string" },
          after: { type: "string", description: "排在这个镜头后面，并建立 continuity 依赖" },
        },
        required: ["id", "title", "durationFrames", "provider", "task"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const s = svc();
        try {
          const before = s.state().shots.length;
          const after = str(args.after);
          s.addShot(
            {
              id: String(args.id),
              title: String(args.title),
              durationFrames: Number(args.durationFrames),
              intent: { description: str(args.description) ?? "", action: "", prompt: str(args.prompt) ?? "" },
              binder: { provider: String(args.provider), task: String(args.task), params: {} },
              subjects: [],
              references: [],
              dependsOn: after ? [{ shot: after, kind: "continuity" }] : [],
            },
            { actor: { kind: "agent", id: "pi" } },
          );
          return { ok: true, shots: before + 1 };
        } finally {
          s.close();
        }
      },
    },
    {
      name: "shot_patch",
      label: "修改镜头",
      description: "局部修改镜头。只传要改的字段；缺省字段保持不变。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          durationFrames: { type: "number" },
          prompt: { type: "string" },
          description: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const s = svc();
        try {
          const patch: Record<string, unknown> = {};
          if (str(args.title)) patch.title = args.title;
          if (num(args.durationFrames) !== undefined) patch.durationFrames = args.durationFrames;
          const intent: Record<string, string> = {};
          if (str(args.prompt)) intent.prompt = str(args.prompt)!;
          if (str(args.description)) intent.description = str(args.description)!;
          if (Object.keys(intent).length) patch.intent = intent;
          s.patchShot(String(args.id), patch, { actor: { kind: "agent", id: "pi" } });
          return { ok: true };
        } finally {
          s.close();
        }
      },
    },
    {
      name: "job_submit",
      label: "提交生成作业",
      description: "为一个镜头提交生成作业。预算不足时会被拒绝并返回原因，不会扣款。",
      parameters: {
        type: "object",
        properties: { shot: { type: "string" } },
        required: ["shot"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const s = svc();
        try {
          return submit(s, registry, { shot: String(args.shot), actor: { kind: "agent", id: "pi" } });
        } finally {
          s.close();
        }
      },
    },
    {
      name: "jobs_run",
      label: "执行作业队列",
      description: "按顺序执行待办作业（本地渲染与远程会话都不并发）。返回每个作业的结果。",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const s = svc();
        try {
          return await runJobs(s, registry, { jobId: str(args.jobId) });
        } finally {
          s.close();
        }
      },
    },
    {
      name: "render_build",
      label: "编译出片",
      description: "按当前状态编译并渲染成片。缺产物或规格不符会被拒绝并返回具体原因。",
      parameters: {
        type: "object",
        properties: { irOnly: { type: "boolean" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const s = svc();
        try {
          const r = await build(s, { irOnly: Boolean(args.irOnly) });
          return { out: r.out, durationFrames: r.durationFrames, sha256: r.sha256, bytes: r.bytes };
        } finally {
          s.close();
        }
      },
    },
    {
      name: "storyboard_projection",
      label: "导出审计投影",
      description: "返回审计故事板的投影 JSON（镜头、检查项、花费），不渲染 HTML。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const s = svc();
        try {
          return projectStoryboard(s, registry);
        } finally {
          s.close();
        }
      },
    },
    {
      name: "cost_ledger",
      label: "读取账本",
      description: "按 provider / 计量类型 / 镜头聚合花费；未知价格单独计数。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const s = svc();
        try {
          return summarize(s.state());
        } finally {
          s.close();
        }
      },
    },
    {
      name: "journal_verify",
      label: "校验事件日志",
      description: "校验哈希链与引用指针；任何篡改都会在这里暴露。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const s = svc();
        try {
          return s.verify();
        } finally {
          s.close();
        }
      },
    },
  ];
}
