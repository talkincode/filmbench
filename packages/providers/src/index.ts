import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

async function probeSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path],
      { stdout: "pipe", stderr: "ignore" },
    );
    const data = JSON.parse(await new Response(proc.stdout).text());
    await proc.exited;
    const s = data.streams?.[0];
    return s ? { width: s.width, height: s.height } : null;
  } catch {
    return null;
  }
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

/** imagine 的视频形态：首帧 + 视频 prompt → 短视频（Gemini Omni / Seedance 等） */
export function imagineVideo(): Provider {
  return {
    id: "imagine/video",
    tasks: ["video"],
    determinism: "nondeterministic",
    modality: "video",
    requiresPrompt: true,
    maxReferences: 1,
    estimate: ({ shot }) => {
      const unit = Number(shot.binder.params.unitPrice ?? process.env.IMAGINE_UNIT_PRICE ?? "NaN");
      const known = Number.isFinite(unit);
      return { amount: known ? unit : 0, currency: "USD", units: "clip", priceUnknown: !known };
    },
    health: () => (has("imagine") ? { ok: true, detail: "imagine 已安装" } : { ok: false, detail: "缺少 imagine CLI" }),
    async run(input: ProviderRunInput) {
      if (!has("imagine")) throw new Error("imagine 未安装");
      const { shot, params, projectDir, format, onLog } = input;
      const model = params.model ?? process.env.IMAGINE_VIDEO_MODEL;
      if (!model) throw new Error("未指定视频模型：params.model 或 IMAGINE_VIDEO_MODEL");
      const prompt = (params.prompt as string) ?? (shot.intent.prompts?.video || shot.intent.prompt);
      if (!prompt) throw new Error(`${shot.id} 没有视频提示词`);
      const seconds = Number(params.duration ?? shot.durationFrames / format.fps);
      const first = (shot.references ?? [])[0];
      const firstPath = first ? input.references?.[first.asset] : undefined;
      if (!firstPath) throw new Error(`${shot.id} 需要一张首帧参考（role 建议 first_frame）`);

      const tmp = join(projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${shot.id}.mp4`);
      const args = [
        "imagine", "generate", "-m", String(model), "-p", prompt, "-o", out,
        "--image", firstPath, "--duration", String(seconds), "--json", "--authorize-spend",
      ];
      const env = envWithFile(String(params.envFile ?? process.env.FILMBENCH_IMAGINE_ENV_FILE ?? ""));
      const { code, stderr } = await run(args, projectDir, onLog, env, input.signal);
      if (code !== 0) throw new Error(`imagine 视频失败：${stderr.split("\n").slice(-6).join("\n")}`);
      if (!existsSync(out)) throw new Error("imagine 没有写出视频");

      // 实测时长：短了就是短了，不能谎报
      const probe = Bun.spawnSync([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out,
      ]);
      const actual = Number(probe.stdout.toString().trim());
      if (Number.isFinite(actual) && actual + 0.15 < seconds) {
        throw new Error(`视频只有 ${actual.toFixed(2)}s，短于镜头要求的 ${seconds}s`);
      }
      const size = (await probeSize(out)) ?? { width: format.width, height: format.height };
      const unit = Number(params.unitPrice ?? process.env.IMAGINE_UNIT_PRICE ?? "NaN");
      const known = Number.isFinite(unit);
      return {
        files: [{ kind: "video" as const, path: out, mime: "video/mp4", width: size.width, height: size.height, durationFrames: shot.durationFrames }],
        ...(known ? { cost: { kind: "api" as const, units: "clip", unitPrice: unit, amount: unit, currency: "USD" } } : { priceUnknown: true }),
      };
    },
  };
}

/**
 * filmbench/title：本地渲染标题卡 / 封面（SVG → PNG，rsvg-convert 或 resvg）。
 *
 * 设计不是"打一行字"：分四个层级——kicker（上方小字）/ title（主标题）/
 * subtitle（一句剧情）/ credits（署名行）；背景可选剧照 + 压暗 + 暗角 + 颗粒。
 * 预设：noir（夜戏，默认）/ paper（纸面）/ minimal（纯底左对齐）。
 */
export function titleCard(): Provider {
  const PRESETS = ["noir", "paper", "minimal"] as const;

  return {
    id: "filmbench/title",
    tasks: ["title"],
    determinism: "deterministic",
    modality: "image",
    requiresPrompt: false,
    maxReferences: 1,
    estimate: () => ({ amount: 0, currency: "USD", units: "card", priceUnknown: false }),
    health: () =>
      has("rsvg-convert") || has("resvg")
        ? { ok: true, detail: `本地渲染：${has("rsvg-convert") ? "rsvg-convert" : "resvg"}` }
        : { ok: false, detail: "需要 rsvg-convert 或 resvg" },
    async run(input: ProviderRunInput) {
      const { shot, params, projectDir, format } = input;
      const W = format.width;
      const H = format.height;
      const preset = (PRESETS.includes(String(params.preset) as any) ? String(params.preset) : "noir") as
        | "noir"
        | "paper"
        | "minimal";
      const dark = preset !== "paper";
      const fg = String(params.fg ?? (dark ? "ece5d7" : "191610"));
      const accent = String(params.accent ?? "ad3a20");
      const scrim = Number(params.scrim ?? 0.66);
      const grain = params.grain !== false;

      const title = String(params.text ?? shot.title);
      const kicker = String(params.kicker ?? "");
      const subtitle = String(params.subtitle ?? shot.intent.description ?? "");
      const credits = String(params.credits ?? "");

      const titleSize = Number(params.size ?? Math.round(W / 9));
      const subtitleSize = Number(params.subtitleSize ?? Math.round(titleSize * 0.2));
      const kickerSize = Number(params.kickerSize ?? Math.round(titleSize * 0.11));
      const creditsSize = Math.round(titleSize * 0.1);
      const align = params.align === "left" ? "left" : "center";

      const bgRef = (shot.references ?? [])[0];
      const bgPath = bgRef ? input.references?.[bgRef.asset] : undefined;

      const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const wrap = (text: string, perLine: number) => {
        const lines: string[] = [];
        for (const raw of text.split("\n")) {
          let line = "";
          for (const ch of raw) {
            if ([...line].length >= perLine) { lines.push(line); line = ""; }
            line += ch;
          }
          if (line) lines.push(line);
        }
        return lines;
      };

      // 背景：纯色 / 剧照 + 压暗
      let bgLayer = `<rect width="${W}" height="${H}" fill="#${dark ? "0b0f12" : "ece5d7"}"/>`;
      if (bgPath && existsSync(bgPath)) {
        const b64 = readFileSync(bgPath).toString("base64");
        const mime = bgPath.endsWith(".png") ? "image/png" : "image/jpeg";
        bgLayer =
          `<image href="data:${mime};base64,${b64}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` +
          `<rect width="${W}" height="${H}" fill="#0a0805" opacity="${scrim}"/>` +
          `<rect width="${W}" height="${H}" fill="url(#vignette)"/>` +
          `<rect width="${W}" height="${H}" fill="url(#bottomFade)"/>`;
      }

      // 颗粒：确定性的点阵（不依赖 feTurbulence，rsvg 支持更稳）
      let grainLayer = "";
      if (grain) {
        let dots = "";
        let seed = 7;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        for (let i = 0; i < 900; i++) {
          const x = Math.round(rnd() * W);
          const y = Math.round(rnd() * H);
          const o = (0.03 + rnd() * 0.05).toFixed(3);
          dots += `<circle cx="${x}" cy="${y}" r="${rnd() > 0.8 ? 1.2 : 0.7}" fill="#fff" opacity="${o}"/>`;
        }
        grainLayer = `<g>${dots}</g>`;
      }

      const titlePerLine = align === "left" ? Math.floor((W * 0.62) / titleSize) : Math.floor((W * 0.8) / titleSize);
      const titleLines = wrap(title, Math.max(2, titlePerLine));
      const lineH = titleSize * 1.22;
      const blockH = titleLines.length * lineH;
      const cx = align === "left" ? Math.round(W * 0.12) : Math.round(W / 2);
      const anchor = align === "left" ? "start" : "middle";
      const centerY = Math.round(H * (bgPath ? 0.5 : 0.47));
      const titleTop = centerY - blockH / 2 + titleSize * 0.78;
      const ruleY = titleTop + blockH - titleSize * 0.12;
      const subLines = wrap(subtitle, Math.floor((W * 0.66) / subtitleSize));
      const subTop = ruleY + subtitleSize * 1.9;
      const kickerY = centerY - blockH / 2 - kickerSize * 2.2;

      const ruleW = Math.min(W * 0.28, titleSize * 3.2);
      const ruleX = align === "left" ? cx : cx - ruleW / 2;

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="vignette" cx="50%" cy="46%" r="72%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
    </radialGradient>
    <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.6"/>
    </linearGradient>
  </defs>
  ${bgLayer}
  ${grainLayer}
  <g font-family="Songti SC, PingFang SC, Iowan Old Style, serif" fill="#${fg}" text-anchor="${anchor}">
    ${
      kicker
        ? `<text x="${cx}" y="${kickerY}" font-family="SF Mono, Menlo, monospace" font-size="${kickerSize}"
             letter-spacing="${Math.round(kickerSize * 0.4)}" opacity="0.62">${esc(kicker)}</text>`
        : ""
    }
    ${titleLines
      .map(
        (line, i) =>
          `<text x="${cx}" y="${titleTop + i * lineH}" font-size="${titleSize}" letter-spacing="${Math.round(
            titleSize * 0.1,
          )}">${esc(line)}</text>`,
      )
      .join("")}
    <rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="2" fill="#${accent}" opacity="0.9"/>
    ${subLines
      .map(
        (line, i) =>
          `<text x="${cx}" y="${subTop + i * subtitleSize * 1.6}" font-family="PingFang SC, Songti SC, sans-serif"
             font-size="${subtitleSize}" letter-spacing="${Math.round(subtitleSize * 0.22)}" opacity="0.74">${esc(
               line,
             )}</text>`,
      )
      .join("")}
    ${
      credits
        ? `<text x="${Math.round(W * 0.12)}" y="${Math.round(H * 0.9)}" font-family="SF Mono, Menlo, monospace"
             font-size="${creditsSize}" letter-spacing="${Math.round(creditsSize * 0.18)}" opacity="0.45" text-anchor="start">${esc(
               credits,
             )}</text>`
        : ""
    }
  </g>
</svg>`;

      const tmp = join(projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const svgPath = join(tmp, `${shot.id}.svg`);
      const out = join(tmp, `${shot.id}.png`);
      writeFileSync(svgPath, svg);
      const cmd = has("rsvg-convert")
        ? ["rsvg-convert", "-w", String(W), "-h", String(H), "-o", out, svgPath]
        : ["resvg", "--width", String(W), "--height", String(H), svgPath, out];
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`标题卡渲染失败：${(await new Response(proc.stderr).text()).slice(-300)}`);

      return {
        files: [{ kind: "image" as const, path: out, mime: "image/png", width: W, height: H, durationFrames: shot.durationFrames }],
        cost: { kind: "local" as const, units: "card", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}

/**
 * filmbench/lyria：Google Lyria（Gemini API 的音乐生成）。
 *
 * 两个踩过的点：
 *   1. `imagine` 0.8 没有音乐后端（只有图像 / 视频 / TTS），所以这里直接走 Gemini API；
 *   2. lyria-3 系列走 generateContent + responseModalities=["AUDIO"]，
 *      不是 Vertex 上 lyria-002 的 :predict。
 * 生成结果不可复现；长出来的部分由编译期按帧数裁掉。
 */
export function lyria(): Provider {
  return {
    id: "filmbench/lyria",
    tasks: ["music"],
    determinism: "nondeterministic",
    maxReferences: 0,
    requiresPrompt: true,
    estimate: () => ({ amount: 0, currency: "USD", units: "clip", priceUnknown: true }),
    health: () => {
      const key = process.env.GEMINI_API_KEY ?? "";
      return key
        ? { ok: true, detail: "GEMINI_API_KEY 已设置（Lyria 走 Gemini API）" }
        : { ok: false, detail: "缺少 GEMINI_API_KEY" };
    },
    async run(input: ProviderRunInput) {
      const { shot, params, projectDir, onLog } = input;
      const key = String(params.apiKey ?? process.env.GEMINI_API_KEY ?? "");
      if (!key) throw new Error("缺少 GEMINI_API_KEY（Lyria 需要它）");
      const model = String(params.model ?? "lyria-3-clip-preview");
      const prompt = String(params.prompt ?? shot.intent.prompt ?? "");
      if (!prompt) throw new Error(`${shot.id} 没有音乐提示词`);
      const base = String(params.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta");
      const generationConfig: Record<string, unknown> = { responseModalities: ["AUDIO"] };
      if (params.seed !== undefined) generationConfig.seed = Number(params.seed);

      onLog?.(`lyria ${model} ← ${prompt.slice(0, 60)}…`);
      const res = await fetch(`${base}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        signal: input.signal,
      });
      if (!res.ok) throw new Error(`Lyria 失败（${res.status}）：${(await res.text()).slice(0, 400)}`);
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const audio = parts
        .map((p) => p.inlineData)
        .find((d) => d?.data && String(d.mimeType ?? "").startsWith("audio/"));
      if (!audio?.data) throw new Error("Lyria 没有返回音频（确认模型支持 AUDIO 输出）");
      const mime = String(audio.mimeType ?? "audio/wav");
      const ext = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("ogg") ? "ogg" : "wav";
      const tmp = join(projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${shot.id}.${ext}`);
      writeFileSync(out, Buffer.from(audio.data, "base64"));

      // 实测时长：短了直接报，不留给编译期才发现对不上
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
      const seconds = Number(probe.stdout.toString().trim());
      const frames = Number.isFinite(seconds) ? Math.round(seconds * input.format.fps) : shot.durationFrames;
      if (Number.isFinite(seconds) && seconds + 0.2 < shot.durationFrames / input.format.fps) {
        throw new Error(
          `Lyria 只给了 ${seconds.toFixed(2)}s，短于镜头要求的 ${(shot.durationFrames / input.format.fps).toFixed(2)}s`,
        );
      }
      return {
        files: [{ kind: "audio" as const, path: out, mime, width: 0, height: 0, durationFrames: frames }],
        priceUnknown: true,
      };
    },
  };
}

/** filmbench/scorekit：用 scorekit 把一份 scene.yaml 编译成配乐 WAV */
export function scorekit(): Provider {
  return {
    id: "filmbench/scorekit",
    tasks: ["music"],
    determinism: "deterministic",
    maxReferences: 0,
    estimate: () => ({ amount: 0, currency: "USD", units: "track", priceUnknown: false }),
    health: () => (has("scorekit") ? { ok: true, detail: "scorekit 已安装" } : { ok: false, detail: "缺少 scorekit" }),
    async run(input: ProviderRunInput) {
      if (!has("scorekit")) throw new Error("scorekit 未安装");
      const scene = String(input.params.scene ?? "");
      if (!scene) throw new Error(`${input.shot.id} 需要 params.scene（scorekit 场景 YAML 路径）`);
      const scenePath = scene.startsWith("/") ? scene : join(input.projectDir, scene);
      if (!existsSync(scenePath)) throw new Error(`场景文件不存在: ${scenePath}`);
      const tmp = join(input.projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const raw = join(tmp, `${input.shot.id}.raw.wav`);
      const out = join(tmp, `${input.shot.id}.wav`);
      // 采样库渲染（sfizz + orchestration）比 GM 好听一个档次；不填就还是默认 SF2
      const renderer = String(input.params.renderer ?? "");
      const orchestration = String(input.params.orchestration ?? "");
      const soundfont = String(input.params.soundfont ?? "");
      const args = ["scorekit", "build", "--output", raw, scenePath, "--json"];
      if (renderer) args.push("--renderer", renderer);
      if (orchestration) args.push("--orchestration", orchestration);
      if (soundfont) args.push("--soundfont", soundfont);
      if (input.params.gain !== undefined) args.push("--gain", String(input.params.gain));
      // scorekit 0.9：房间与响度是构建输入（scene 里的 reverb 只是送进房间的量）
      // sfizz 没有环境级，--space 非 dry 会被它拒绝；房间里的事用 postFilter 做
      if (input.params.space !== undefined) args.push("--space", String(input.params.space));
      if (input.params.master !== undefined) args.push("--master", String(input.params.master));
      if (input.params.masterTruePeak !== undefined) {
        args.push("--master-true-peak", String(input.params.masterTruePeak));
      }
      const { code, stderr } = await run(args, input.projectDir, input.onLog, undefined, input.signal);
      if (code !== 0) throw new Error(`scorekit 失败：${stderr.split("\n").slice(-6).join("\n")}`);
      if (!existsSync(raw)) throw new Error("scorekit 没有写出音频");
      // 母带小修（高通 / 高音架）跟渲染在同一个作业里完成，不另开手工链路
      const post = String(input.params.postFilter ?? "");
      // 卷积混响：sfizz 没有环境级，房间用一条 IR 在 ffmpeg 里做（两路输入：干声 + IR）
      const ir = String(input.params.postIR ?? "");
      if (ir) {
        const irPath = ir.startsWith("/") ? ir : join(input.projectDir, ir);
        if (!existsSync(irPath)) throw new Error(`脉冲响应不存在: ${ir}`);
        const room = String(input.params.postIRMix ?? "dry=8:wet=5:irgain=0.95:irnorm=1");
        const graph =
          `[0:a]aresample=48000[src];[src][1:a]afir=${room}[roomy];` +
          (post ? `[roomy]${post}[out]` : `[roomy]anull[out]`);
        const mixed = await run(
          ["ffmpeg", "-y", "-i", raw, "-i", irPath, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", out],
          input.projectDir,
          input.onLog,
          undefined,
          input.signal,
        );
        if (mixed.code !== 0) throw new Error(`混响处理失败：${mixed.stderr.split("\n").slice(-6).join("\n")}`);
      } else if (post) {
        const master = await run(
          ["ffmpeg", "-y", "-i", raw, "-af", post, "-c:a", "pcm_s16le", out],
          input.projectDir,
          input.onLog,
          undefined,
          input.signal,
        );
        if (master.code !== 0) throw new Error(`母带处理失败：${master.stderr.split("\n").slice(-6).join("\n")}`);
      } else {
        copyFileSync(raw, out);
      }
      if (!existsSync(out)) throw new Error("没有写出音频");
      return {
        files: [
          {
            kind: "audio" as const,
            path: out,
            mime: "audio/wav",
            width: 0,
            height: 0,
            durationFrames: input.shot.durationFrames,
          },
        ],
        cost: { kind: "local" as const, units: "track", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}

/** filmbench/qwentts：本地 Qwen3-TTS 生成旁白 */
export function qwentts(): Provider {
  return {
    id: "filmbench/qwentts",
    tasks: ["voice"],
    determinism: "nondeterministic",
    estimate: () => ({ amount: 0, currency: "USD", units: "line", priceUnknown: false }),
    health: () =>
      Bun.which(process.env.FILMBENCH_QWENTTS ?? "qwen3-tts-ai")
        ? { ok: true, detail: "qwen3-tts-ai 可用" }
        : { ok: false, detail: "缺少 qwen3-tts-ai（qwentts skill）" },
    async run(input: ProviderRunInput) {
      const bin = process.env.FILMBENCH_QWENTTS ?? "qwen3-tts-ai";
      if (!Bun.which(bin)) throw new Error("qwen3-tts-ai 未安装");
      const text = String(input.params.text ?? input.shot.intent.narration ?? "");
      if (!text.trim()) throw new Error(`${input.shot.id} 没有旁白文本（intent.narration 或 params.text）`);
      const tmp = join(input.projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${input.shot.id}.wav`);
      // 有参考音频就走 base 克隆（男声/女声由参考决定），否则用 CustomVoice 预置音色
      const referenceAudio = String(input.params.referenceAudio ?? "");
      const model = String(input.params.model ?? "customvoice");
      const instruct = String(input.params.instruct ?? "");
      const args =
        referenceAudio && referenceAudio !== "false"
          ? [
              bin, "-t", text, "-o", out,
              "--model", "base",
              "--reference-audio", referenceAudio,
              "--speed", String(input.params.speed ?? 1),
            ]
          : model === "voice-design"
            ? [
                // VoiceDesign：靠一段描述造音色，不指定 --voice
                bin, "-t", text, "-o", out,
                "--model", "voice-design",
                ...(instruct ? ["--instruct", instruct] : []),
                "--speed", String(input.params.speed ?? 1),
              ]
            : [
                bin, "-t", text, "-o", out,
                "--model", model,
                "--voice", String(input.params.voice ?? "Serena"),
                "--emotion-intensity", String(input.params.emotion ?? "low"),
                ...(instruct ? ["--instruct", instruct] : []),
                "--speed", String(input.params.speed ?? 1),
              ];
      const { code, stderr } = await run(args, input.projectDir, input.onLog, undefined, input.signal);
      if (code !== 0) throw new Error(`qwentts 失败：${stderr.split("\n").slice(-4).join("\n")}`);
      if (!existsSync(out)) throw new Error("qwentts 没有写出音频");
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
      const seconds = Number(probe.stdout.toString().trim());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("无法读取旁白时长");
      const frames = Math.round(seconds * input.format.fps);
      input.onLog?.(`旁白 ${seconds.toFixed(2)}s / ${frames}f`);
      return {
        files: [{ kind: "audio" as const, path: out, mime: "audio/wav", width: 0, height: 0, durationFrames: frames }],
        cost: { kind: "local" as const, units: "line", unitPrice: 0, amount: 0, currency: "USD" },
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

/**
 * import：把项目里已经存在的文件登记成镜头产物（不转码、不重算）。
 *
 * 有些素材根本不该由 filmbench 生成——比如舆图录制、实拍补拍、别人给的一段音乐。
 * 它们也必须走同一条「产物 → 选片 → 审阅 → 编译」的路，而不是绕过作业直接塞进 IR；
 * 否则账本、哈希链、过期判定都会出现盲区。长度与画幅按实测校验，短了就是短了。
 */
export function importFile(): Provider {
  return {
    id: "filmbench/import",
    tasks: ["import"],
    determinism: "deterministic",
    estimate: () => ({ amount: 0, currency: "USD", units: "file", priceUnknown: false }),
    health: () => (has("ffprobe") ? { ok: true, detail: "ffprobe 可用" } : { ok: false, detail: "缺少 ffprobe" }),
    async run(input: ProviderRunInput) {
      const { shot, params, projectDir, format } = input;
      const rel = String(params.file ?? "");
      if (!rel) throw new Error(`${shot.id} 需要 params.file（相对项目根或绝对路径）`);
      const file = rel.startsWith("/") ? rel : join(projectDir, rel);
      if (!existsSync(file)) throw new Error(`文件不存在: ${rel}`);
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      const kind = (params.kind as "video" | "image" | "audio" | undefined) ??
        (["mp4", "mov", "mkv", "webm"].includes(ext)
          ? "video"
          : ["wav", "mp3", "flac", "aac", "m4a"].includes(ext)
            ? "audio"
            : "image");
      const mime = ext === "png" ? "image/png" : ["jpg", "jpeg"].includes(ext) ? "image/jpeg" : ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : "video/mp4";
      const info = await probeMedia(file);
      const durationFrames =
        kind === "image" ? shot.durationFrames : info.frames || Math.round(info.duration * format.fps);
      if (kind !== "image" && Math.abs(durationFrames - shot.durationFrames) > 1) {
        throw new Error(
          `实际 ${durationFrames} 帧（${info.duration.toFixed(2)}s），镜头声明 ${shot.durationFrames} 帧——先对齐长度再导入`,
        );
      }
      return {
        files: [
          {
            kind,
            path: file,
            mime,
            width: kind === "audio" ? 0 : info.width,
            height: kind === "audio" ? 0 : info.height,
            durationFrames,
          },
        ],
        cost: { kind: "local" as const, units: "file", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}

/** 实测一条媒体的画幅与帧数（视频按 nb_frames，取不到再用时长×帧率） */
async function probeMedia(path: string): Promise<{ width: number; height: number; frames: number; duration: number }> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,duration",
        "-show_entries", "format=duration", "-of", "json", path,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const data = JSON.parse(await new Response(proc.stdout).text());
    await proc.exited;
    const s = data.streams?.[0];
    const duration = Number(s?.duration ?? data.format?.duration ?? 0);
    const [num, den] = String(s?.avg_frame_rate ?? "0/1").split("/").map(Number);
    const fps = den ? num / den : 0;
    const frames = Number(s?.nb_frames) || (fps ? Math.round(duration * fps) : 0);
    return { width: Number(s?.width ?? 0), height: Number(s?.height ?? 0), frames, duration };
  } catch {
    return { width: 0, height: 0, frames: 0, duration: 0 };
  }
}

export function builtinProviders(): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  for (const p of [
    colorcard(),
    titleCard(),
    scorekit(),
    qwentts(),
    imagine(),
    imagineVideo(),
    colab(),
    remotion(),
    hyperframes(),
    browserCapture(),
    importFile(),
    lyria(),
  ]) {
    registry.set(p.id, p);
  }
  return registry;
}

/** Remotion：跑项目里的 npx remotion render，产物是 mp4 */
export function remotion(): Provider {
  return {
    id: "filmbench/remotion",
    tasks: ["render"],
    determinism: "deterministic",
    estimate: () => ({ amount: 0, currency: "USD", units: "render", priceUnknown: false }),
    health: () => {
      const bin = Bun.which("node");
      return bin ? { ok: true, detail: "node 可用（remotion 由项目依赖提供）" } : { ok: false, detail: "缺少 node" };
    },
    async run(input: ProviderRunInput) {
      const rawCwd = String(input.params.cwd ?? ".");
      const cwd = rawCwd.startsWith("/") ? rawCwd : join(input.projectDir, rawCwd);
      const entry = String(input.params.entry ?? "src/index.ts");
      const composition = String(input.params.composition ?? "");
      if (!composition) throw new Error(`${input.shot.id} 需要 params.composition（Remotion composition id）`);
      const tmp = join(input.projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${input.shot.id}.mp4`);
      const propsPath = join(tmp, `${input.shot.id}.props.json`);
      writeFileSync(propsPath, JSON.stringify(input.params.props ?? {}, null, 2));
      const bin = join(cwd, "node_modules/.bin/remotion");
      const cmd = existsSync(bin) ? bin : "npx";
      const args = existsSync(bin)
        ? ["render", entry, composition, out, `--props=${propsPath}`]
        : ["-y", "remotion", "render", entry, composition, out, `--props=${propsPath}`];
      const { code, stderr } = await run([cmd, ...args], cwd, input.onLog, undefined, input.signal);
      if (code !== 0) throw new Error(`remotion 失败：${stderr.split("\n").slice(-6).join("\n")}`);
      if (!existsSync(out)) throw new Error("remotion 没有写出视频");
      // composition 自己的尺寸可能与项目格式不一致：按实测登记，别信声明
      const info = await probeMedia(out);
      return {
        files: [
          {
            kind: "video" as const,
            path: out,
            mime: "video/mp4",
            width: info.width || input.format.width,
            height: info.height || input.format.height,
            durationFrames: info.frames || input.shot.durationFrames,
          },
        ],
        cost: { kind: "local" as const, units: "render", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}

/** HyperFrames：npx hyperframes render <dir>，产物是 mp4 */
export function hyperframes(): Provider {
  return {
    id: "filmbench/hyperframes",
    tasks: ["render"],
    determinism: "deterministic",
    estimate: () => ({ amount: 0, currency: "USD", units: "render", priceUnknown: false }),
    health: () => (Bun.which("npx") ? { ok: true, detail: "npx 可用（首次会下载 hyperframes CLI）" } : { ok: false, detail: "缺少 npx" }),
    async run(input: ProviderRunInput) {
      const rawProject = String(input.params.project ?? ".");
      const projectDir = rawProject.startsWith("/") ? rawProject : join(input.projectDir, rawProject);
      if (!existsSync(join(projectDir, "index.html")) && !input.params.composition) {
        throw new Error(`${input.shot.id} 需要 params.project（含 index.html）或 params.composition`);
      }
      const tmp = join(input.projectDir, ".filmbench", "tmp");
      mkdirSync(tmp, { recursive: true });
      const out = join(tmp, `${input.shot.id}.mp4`);
      const args = ["-y", "hyperframes", "render", projectDir, "-o", out, "-f", String(input.format.fps)];
      if (input.params.composition) args.push("-c", String(input.params.composition));
      args.push("-q", String(input.params.quality ?? "looks"));
      const { code, stderr } = await run(["npx", ...args], input.projectDir, input.onLog, undefined, input.signal);
      if (code !== 0) throw new Error(`hyperframes 失败：${stderr.split("\n").slice(-6).join("\n")}`);
      if (!existsSync(out)) throw new Error("hyperframes 没有写出视频");
      const info = await probeMedia(out);
      return {
        files: [
          {
            kind: "video" as const,
            path: out,
            mime: "video/mp4",
            width: info.width || input.format.width,
            height: info.height || input.format.height,
            durationFrames: info.frames || input.shot.durationFrames,
          },
        ],
        cost: { kind: "local" as const, units: "render", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}

/**
 * browser：把一张 HTML（Three.js / canvas / WebGL）逐帧渲染成视频。
 * 契约：页面暴露 `window.__seek(frame)` 同步渲染第 frame 帧；provider 用 headless Chrome 逐帧截图。
 */
export function browserCapture(): Provider {
  return {
    id: "filmbench/browser",
    tasks: ["capture"],
    determinism: "deterministic",
    estimate: () => ({ amount: 0, currency: "USD", units: "frame", priceUnknown: false }),
    health: () => {
      const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      return existsSync(chrome)
        ? { ok: true, detail: chrome }
        : { ok: false, detail: "缺少 Chrome（设置 CHROME_PATH）" };
    },
    async run(input: ProviderRunInput) {
      const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (!existsSync(chrome)) throw new Error("缺少 Chrome（设置 CHROME_PATH）");
      const page = String(input.params.page ?? "");
      if (!page) throw new Error(`${input.shot.id} 需要 params.page（HTML 路径，暴露 window.__seek(frame)）`);
      const pagePath = page.startsWith("/") ? page : join(input.projectDir, page);
      if (!existsSync(pagePath)) throw new Error(`页面不存在: ${pagePath}`);
      const frames = input.shot.durationFrames;
      const tmp = join(input.projectDir, ".filmbench", "tmp", input.shot.id);
      mkdirSync(tmp, { recursive: true });
      const width = input.format.width;
      const height = input.format.height;

      for (let i = 0; i < frames; i++) {
        const png = join(tmp, `${String(i).padStart(4, "0")}.png`);
        const url = `file://${pagePath}?frame=${i}`;
        const { code, stderr } = await run(
          [
            chrome, "--headless=new", "--hide-scrollbars",
            "--allow-file-access-from-files",
            // 模块 import / WebGL 首帧是异步的：给虚拟时间预算，否则截到黑屏
            `--virtual-time-budget=${String(input.params.budgetMs ?? 8000)}`,
            `--window-size=${width},${height}`,
            `--screenshot=${png}`, url,
          ],
          input.projectDir,
          undefined,
          undefined,
          input.signal,
        );
        if (code !== 0 || !existsSync(png)) throw new Error(`第 ${i} 帧截图失败：${stderr.slice(-200)}`);
        if (i % 10 === 0) input.onLog?.(`capture ${i + 1}/${frames}`);
      }

      const out = join(input.projectDir, ".filmbench", "tmp", `${input.shot.id}.mp4`);
      const { code, stderr } = await run(
        ["ffmpeg", "-y", "-framerate", String(input.format.fps), "-i", join(tmp, "%04d.png"),
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(input.format.fps), out],
        input.projectDir,
        input.onLog,
        undefined,
        input.signal,
      );
      if (code !== 0) throw new Error(`拼帧失败：${stderr.slice(-300)}`);
      return {
        files: [{ kind: "video" as const, path: out, mime: "video/mp4", width, height, durationFrames: frames }],
        cost: { kind: "local" as const, units: "frame", unitPrice: 0, amount: 0, currency: "USD" },
      };
    },
  };
}
