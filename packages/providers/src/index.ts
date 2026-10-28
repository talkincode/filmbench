import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider, ProviderRegistry, ProviderRunInput } from "@filmbench/core";
import { colabRunJob } from "./colab.ts";
export * from "./colab.ts";

const PALETTE = ["0x1a2733", "0x2b1f2a", "0x1d2a24", "0x2a2118", "0x22202e", "0x2e2420"];

function colorFor(seed: string): string {
  const n = createHash("sha256").update(seed).digest()[0];
  return PALETTE[n % PALETTE.length];
}

async function run(
  cmd: string[],
  cwd: string,
  onLog?: (l: string) => void,
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? (process.env as Record<string, string>),
  });
  const onAbort = () => {
    try { proc.kill(); } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (out.trim()) for (const line of out.trim().split("\n").slice(-80)) onLog?.(line);
    if (err.trim()) for (const line of err.trim().split("\n").slice(-80)) onLog?.(line);
    return { code, stderr: err };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

const has = (bin: string) => Boolean(Bun.which(bin));

/** 读 KEY=VALUE / export KEY=VALUE 形式的凭据文件，只补缺失的变量 */
function envWithFile(file: string | undefined): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  if (!file || !existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!env[key]) env[key] = value;
  }
  return env;
}

async function probe(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path],
      { stdout: "pipe", stderr: "ignore" },
    );
    const data = JSON.parse(await new Response(proc.stdout).text());
    await proc.exited;
    const stream = data.streams?.[0];
    return stream ? { width: stream.width, height: stream.height } : null;
  } catch {
    return null;
  }
}

/**
 * 本地产线卡：用 ffmpeg 的 lavfi 生成纯色片段。
 * 存在的意义是让整条链路（提交 → 预算 → 执行 → 内容寻址 → 编译 → 出片）在没有凭据的机器上也能端到端跑通。
 */
export function colorcard(): Provider {
  return {
    id: "filmbench/colorcard",
    tasks: ["clip"],
    determinism: "deterministic",
    estimate: () => ({ amount: 0, currency: "USD", units: "clip", priceUnknown: false }),
    health: () => (has("ffmpeg") ? { ok: true, detail: "ffmpeg 可用" } : { ok: false, detail: "缺少 ffmpeg" }),
    async run(input: ProviderRunInput) {
      if (!has("ffmpeg")) throw new Error("colorcard 需要 ffmpeg");
      const { shot, format, projectDir, params, onLog } = input;
      const color = String(params.color ?? colorFor(shot.id));
      const tmp = join(projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${shot.id}.mp4`);
      const seconds = (shot.durationFrames / format.fps).toFixed(3);
      const { code, stderr } = await run(
        [
          "ffmpeg",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=${format.width}x${format.height}:r=${format.fps}:d=${seconds}`,
          "-t",
          seconds,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-r",
          String(format.fps),
          out,
        ],
        projectDir,
        onLog,
        undefined,
        input.signal,
      );
      if (code !== 0) throw new Error(`ffmpeg 生成片段失败：${stderr.split("\n").slice(-4).join("\n")}`);
      if (!existsSync(out)) throw new Error("ffmpeg 没有写出文件");
      return {
        files: [
          {
            kind: "video" as const,
            path: out,
            mime: "video/mp4",
            width: format.width,
            height: format.height,
            durationFrames: shot.durationFrames,
          },
        ],
        cost: { kind: "local" as const, units: "clip", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}

/** imagine：出图。价格没有登记就是未知，绝不按 0 记账。 */
export function imagine(): Provider {
  return {
    id: "imagine",
    tasks: ["image"],
    determinism: "nondeterministic",
    modality: "image" as const,
    requiresPrompt: true,
    maxReferences: 5,
    estimate: ({ shot }) => {
      const unit = Number(shot.binder.params.unitPrice ?? process.env.IMAGINE_UNIT_PRICE ?? "NaN");
      const known = Number.isFinite(unit);
      return {
        amount: known ? unit : 0,
        currency: "USD",
        units: "image",
        priceUnknown: !known,
      };
    },
    health: () => {
      if (!has("imagine")) return { ok: false, detail: "缺少 imagine CLI" };
      return { ok: true, detail: "imagine 已安装" };
    },
    async run(input: ProviderRunInput) {
      if (!has("imagine")) throw new Error("imagine 未安装");
      const { shot, params, projectDir, format, onLog } = input;
      const model = params.model ?? process.env.IMAGINE_MODEL;
      if (!model) throw new Error("未指定 model：在镜头 binder.params.model 或 IMAGINE_MODEL 里给出");
      const prompt = String(params.prompt ?? shot.intent.prompt);
      if (!prompt) throw new Error(`${shot.id} 没有 prompt`);
      const tmp = join(projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${shot.id}.png`);
      const width = Number(params.width ?? format.width);
      const height = Number(params.height ?? format.height);
      const args = ["imagine", "generate", "-m", String(model), "-p", prompt, "-o", out, "--width", String(width), "--height", String(height), "--json"];

      // 参考图：按镜头里声明的顺序喂给模型，最多 provider 上限
      const limit = 5;
      const refs = (shot.references ?? []).slice(0, limit);
      for (const ref of refs) {
        const asset = input.references?.[ref.asset];
        if (!asset) throw new Error(`参考素材未登记: ${ref.asset}`);
        args.push("--image", asset);
      }
      if (params.dryRun) args.push("--dry-run");
      else args.push("--authorize-spend");
      const env = envWithFile(String(params.envFile ?? process.env.FILMBENCH_IMAGINE_ENV_FILE ?? ""));
      const { code, stderr } = await run(args, projectDir, onLog, env, input.signal);
      if (code !== 0) throw new Error(`imagine 失败：${stderr.split("\n").slice(-4).join("\n")}`);
      if (!existsSync(out)) throw new Error("imagine 没有写出图片");
      const size = (await probe(out)) ?? { width, height };
      const unit = Number(params.unitPrice ?? process.env.IMAGINE_UNIT_PRICE ?? "NaN");
      const known = Number.isFinite(unit);
      return {
        files: [
          {
            kind: "image" as const,
            path: out,
            mime: "image/png",
            width: size.width,
            height: size.height,
            durationFrames: shot.durationFrames,
          },
        ],
        ...(known
          ? { cost: { kind: "api" as const, units: "image", unitPrice: unit, amount: unit, currency: "USD" } }
          : { priceUnknown: true }),
      };
    },
  };
}

/**
 * colab：可复用会话。第一次 up 时装环境/下模型，之后每个作业只传 spec、跑图、取结果；
 * 30 分钟无活动由本地 reap 与 VM 内 watchdog 双重停掉。
 */
export function colab(): Provider {
  return {
    id: "colab",
    tasks: ["video"],
    determinism: "nondeterministic",
    modality: "video",
    requiresPrompt: true,
    maxReferences: 3,
    estimate: ({ shot }) => {
      const cu = Number(shot.binder.params.cuBudget ?? "NaN");
      const rate = Number(process.env.FILMBENCH_CU_PRICE ?? "NaN");
      if (!Number.isFinite(cu) || !Number.isFinite(rate)) {
        return { amount: 0, currency: "USD", units: "CU", priceUnknown: true };
      }
      return { amount: Math.round(cu * rate * 1000) / 1000, currency: "USD", units: "CU", priceUnknown: false };
    },
    health: () => {
      const bin = process.env.FILMBENCH_COLAB_BIN ?? "colab";
      return has(bin) ? { ok: true, detail: "colab 已安装（会话复用）" } : { ok: false, detail: "缺少 colab CLI" };
    },
    async run(input: ProviderRunInput) {
      if (!has(process.env.FILMBENCH_COLAB_BIN ?? "colab")) throw new Error("colab 未安装");
      const jobId = input.jobId ?? `${String(input.shot.id)}-${Date.now().toString(36)}`;
      const { path } = await colabRunJob({ ...input, jobId });
      return {
        files: [
          {
            kind: "video" as const,
            path,
            mime: "video/mp4",
            width: input.format.width,
            height: input.format.height,
            durationFrames: input.shot.durationFrames,
          },
        ],
        cost: { kind: "compute" as const, units: "CU", unitPrice: 0, amount: 0, currency: "USD" },
        priceUnknown: true,
      };
    },
  };
}

/** 通用本地命令：把任意 CLI（qwentts / scorekit / hyperframes / remotion）接成 provider */
export function localProc(config: {
  id: string;
  tasks: string[];
  command: string[];
  determinism?: Provider["determinism"];
  unitPrice?: number;
}): Provider {
  return {
    id: config.id,
    tasks: config.tasks,
    determinism: config.determinism ?? "deterministic",
    estimate: () => ({
      amount: config.unitPrice ?? 0,
      currency: "USD",
      units: "run",
      priceUnknown: config.unitPrice === undefined,
    }),
    health: () => {
      const bin = config.command[0];
      return has(bin) ? { ok: true, detail: `${bin} 可用` } : { ok: false, detail: `缺少 ${bin}` };
    },
    async run(input: ProviderRunInput) {
      const out = join(input.projectDir, ".filmbench", "tmp", `${input.shot.id}.out`);
      mkdirSync(join(input.projectDir, ".filmbench", "tmp"), { recursive: true });
      const fill = (token: string) =>
        token
          .replaceAll("{out}", out)
          .replaceAll("{project}", input.projectDir)
          .replaceAll("{prompt}", input.shot.intent.prompt)
          .replaceAll("{frames}", String(input.shot.durationFrames))
          .replaceAll("{fps}", String(input.format.fps))
          .replaceAll("{shot}", input.shot.id);
      const args = config.command.map(fill);
      const { code, stderr } = await run(args, input.projectDir, input.onLog, undefined, input.signal);
      if (code !== 0) throw new Error(`${config.id} 失败：${stderr.split("\n").slice(-4).join("\n")}`);
      if (!existsSync(out)) throw new Error(`${config.id} 没有写出 {out}`);
      return {
        files: [
          {
            kind: "video" as const,
            path: out,
            mime: "video/mp4",
            width: input.format.width,
            height: input.format.height,
            durationFrames: input.shot.durationFrames,
          },
        ],
        cost: { kind: "local" as const, units: "run", unitPrice: config.unitPrice ?? 0, amount: config.unitPrice ?? 0, currency: "USD" },
      };
    },
  };
}

export function builtinProviders(): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  for (const p of [colorcard(), imagine(), colab()]) registry.set(p.id, p);
  return registry;
}
