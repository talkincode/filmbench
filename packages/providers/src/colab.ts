import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { Provider, ProviderRunInput } from "@filmbench/core";

/**
 * Colab 会话管理。核心诉求不是"能跑一次"，而是：
 *   1. 环境与模型只装/下一次（persist 到 Drive，哈希 marker 命中就跳过）；
 *   2. 会话复用，作业之间不重开；
 *   3. 30 分钟无活动就停（本地 reap + VM 内 watchdog 双保险）。
 */

export interface ColabState {
  session: string;
  gpu: string;
  workflow: string;
  workflowHash: string;
  remoteDir: string;
  persist: string;
  idleMinutes: number;
  createdAt: string;
  lastActiveAt: string;
}

const IDLE_DEFAULT = 30;

const statePath = (projectDir: string) => join(projectDir, ".filmbench", "colab.json");

export function readColabState(projectDir: string): ColabState | null {
  try {
    return JSON.parse(readFileSync(statePath(projectDir), "utf8")) as ColabState;
  } catch {
    return null;
  }
}

function writeColabState(projectDir: string, state: ColabState): void {
  mkdirSync(join(projectDir, ".filmbench"), { recursive: true });
  writeFileSync(statePath(projectDir), `${JSON.stringify(state, null, 2)}\n`);
}

function clearColabState(projectDir: string): void {
  rmSync(statePath(projectDir), { force: true });
}

export function touchColabActivity(projectDir: string): void {
  const state = readColabState(projectDir);
  if (!state) return;
  writeColabState(projectDir, { ...state, lastActiveAt: new Date().toISOString() });
}

export function colabWorkflowDir(projectDir: string, name: string): string {
  const candidates = [join(projectDir, "workflows", name), join(import.meta.dir, "../../../workflows", name)];
  for (const dir of candidates) if (existsSync(join(dir, "workflow.json"))) return resolve(dir);
  throw new Error(`找不到工作流 ${name}（找过 ${candidates.join(", ")}）`);
}

export interface ColabSpec {
  name: string;
  gpu?: string;
  remoteDir?: string;
  persist?: string;
  idleMinutes?: number;
  setup?: string;
  run?: string;
  out?: string;
}

export function readColabSpec(dir: string): ColabSpec {
  return JSON.parse(readFileSync(join(dir, "workflow.json"), "utf8")) as ColabSpec;
}

/** 工作流包的内容哈希：改了任何脚本/图，哈希就变，setup 自动重跑 */
export function colabWorkflowHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "node_modules" || name === "__pycache__") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        hash.update(relative(dir, p));
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

interface ColabRun {
  code: number;
  out: string;
  err: string;
}

export async function runColab(
  args: string[],
  cwd: string,
  options: { onLog?: (l: string) => void; timeoutMs?: number } = {},
): Promise<ColabRun> {
  // 允许替换二进制：测试用假 CLI，生产一般就是 PATH 里的 colab
  const bin = process.env.FILMBENCH_COLAB_BIN ?? "colab";
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : null;
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    for (const line of (out + "\n" + err).split("\n")) if (line.trim()) options.onLog?.(line);
    return { code, out, err };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const NOISE = /^\[colab\]|update|A new version|^\s*$/i;

function cleanLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && !NOISE.test(l));
}

/** 解析 `colab sessions` 的会话名列表 */
export async function listColabSessions(): Promise<string[]> {
  const { code, out } = await runColab(["sessions"], process.cwd());
  if (code !== 0) return [];
  return cleanLines(out)
    .filter((l) => !/^[-+|]/.test(l) && !/session/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

function sessionName(projectDir: string, workflow: string): string {
  const slug = basename(projectDir).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20) || "project";
  return `fb-${slug}-${workflow}`.slice(0, 60);
}

function packWorkflow(dir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "fb-colab-"));
  const tar = join(tmp, "pkg.tar.gz");
  const proc = Bun.spawnSync(["tar", "czf", tar, "-C", dir, "."]);
  if (proc.exitCode !== 0) throw new Error(`打包工作流失败: ${proc.stderr.toString()}`);
  return tar;
}

export interface ColabUpOptions {
  projectDir: string;
  workflow?: string;
  gpu?: string;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

async function execFile(
  session: string,
  script: string,
  cwd: string,
  env: Record<string, string>,
  timeoutSec: number,
  options: { onLog?: (l: string) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const args = ["exec", "--session", session, "--file", script, "--timeout", String(timeoutSec)];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  const r = await runColab(args, cwd, { onLog: options.onLog, timeoutMs: (timeoutSec + 60) * 1000 });
  if (r.code !== 0) throw new Error(`colab exec ${basename(script)} 失败：${r.err.slice(-400)}`);
}

/**
 * 建会话或复用它。复用条件：会话还活着 + 工作流哈希一致。
 * 只有工作流真的变了才重建，避免每次都重装环境、重下模型。
 */
export async function colabUp(options: ColabUpOptions): Promise<ColabState> {
  const { projectDir, onLog } = options;
  const workflowName = options.workflow ?? "comfy-h3";
  const dir = colabWorkflowDir(projectDir, workflowName);
  const spec = readColabSpec(dir);
  const hash = colabWorkflowHash(dir);
  const session = sessionName(projectDir, workflowName);
  const alive = await listColabSessions();
  const existing = readColabState(projectDir);

  if (existing && alive.includes(existing.session) && existing.workflowHash === hash) {
    const next = { ...existing, lastActiveAt: new Date().toISOString() };
    writeColabState(projectDir, next);
    onLog?.(`复用会话 ${existing.session}（工作流未变）`);
    return next;
  }

  if (alive.includes(session)) {
    onLog?.(`会话 ${session} 已存在但工作流变了，先停掉重建`);
    await runColab(["stop", "--session", session], projectDir, { onLog });
  }

  const gpu = options.gpu ?? spec.gpu ?? "L4";
  const remoteDir = spec.remoteDir ?? "/content/filmbench";
  const persist = spec.persist ?? `${remoteDir}/persist`;
  const idleMinutes = Number(spec.idleMinutes ?? IDLE_DEFAULT);

  onLog?.(`创建会话 ${session}（${gpu}）`);
  const created = await runColab(["new", "--session", session, "--gpu", gpu], projectDir, { onLog });
  if (created.code !== 0) throw new Error(`colab new 失败：${created.err.slice(-400)}`);

  try {
    const pkg = packWorkflow(dir);
    const remotePkg = `${remoteDir}/pkg.tar.gz`;
    const up = await runColab(["upload", pkg, remotePkg, "--session", session], projectDir, { onLog });
    if (up.code !== 0) throw new Error(`上传工作流失败：${up.err.slice(-400)}`);
    rmSync(pkg, { force: true });

    const env = { FILMBENCH_REMOTE: remoteDir, FILMBENCH_IDLE_MINUTES: String(idleMinutes) };
    onLog?.("解包工作流…");
    await execFile(session, join(dir, "bootstrap.py"), projectDir, env, 300, { onLog });
    onLog?.("准备环境（persist 命中则跳过安装）…");
    await execFile(session, join(dir, spec.setup ?? "setup.py"), projectDir, env, 1800, { onLog });
    await execFile(session, join(dir, "heartbeat.py"), projectDir, env, 120, { onLog });
  } catch (err) {
    // 建会话失败要收尾，不然会话会挂着烧 CU
    await runColab(["stop", "--session", session], projectDir, { onLog });
    throw err;
  }

  const state: ColabState = {
    session,
    gpu,
    workflow: workflowName,
    workflowHash: hash,
    remoteDir,
    persist,
    idleMinutes,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
  writeColabState(projectDir, state);
  onLog?.(`会话就绪：${session}`);
  return state;
}

/** 执行一个作业：传 spec 与参考图 → run.py → 取回产物 → heartbeat。 */
export async function colabRunJob(input: ProviderRunInput & { jobId: string }): Promise<{ path: string; remoteOut: string }> {
  const { projectDir, onLog } = input;
  const workflowName = String(input.params.workflow ?? "comfy-h3");
  const state = await colabUp({ projectDir, workflow: workflowName, gpu: input.params.gpu as string, onLog });
  const dir = colabWorkflowDir(projectDir, workflowName);
  const spec = readColabSpec(dir);
  const remote = state.remoteDir;
  const jobDir = `${remote}/jobs/${input.jobId}`;
  const remoteOut = (spec.out ?? `${remote}/out/{jobId}.mp4`).replace("{jobId}", input.jobId);

  // 参考图先传：按镜头声明顺序，最多 provider 上限
  const refs: string[] = [];
  for (const [i, ref] of (input.shot.references ?? []).entries()) {
    const local = input.references?.[ref.asset];
    if (!local) continue;
    const remoteRef = `${jobDir}/refs/${i}-${ref.role}.png`;
    const up = await runColab(["upload", local, remoteRef, "--session", state.session], projectDir, { onLog });
    if (up.code !== 0) throw new Error(`上传参考图失败：${up.err.slice(-300)}`);
    refs.push(remoteRef);
  }

  const jobSpec = {
    jobId: input.jobId,
    workflow: spec.comfy ?? "comfy/workflow.json",
    params: {
      ...input.params,
      prompt:
        (input.params.prompt as string | undefined) ??
        (input.shot.intent.prompts?.video || input.shot.intent.prompt),
      width: input.params.width ?? input.format.width,
      height: input.params.height ?? input.format.height,
      seconds: input.shot.durationFrames / input.format.fps,
    },
    refs,
    out: remoteOut,
    timeoutSec: Number(process.env.FILMBENCH_COLAB_JOB_TIMEOUT_SEC ?? 1200),
  };
  const localSpec = join(projectDir, ".filmbench", "tmp", `${input.jobId}.json`);
  mkdirSync(join(projectDir, ".filmbench", "tmp"), { recursive: true });
  writeFileSync(localSpec, JSON.stringify(jobSpec, null, 2));
  const remoteSpec = `${jobDir}/job.json`;
  const upSpec = await runColab(["upload", localSpec, remoteSpec, "--session", state.session], projectDir, { onLog });
  if (upSpec.code !== 0) throw new Error(`上传作业 spec 失败：${upSpec.err.slice(-300)}`);

  const env = {
    FILMBENCH_REMOTE: remote,
    FILMBENCH_IDLE_MINUTES: String(state.idleMinutes),
    FILMBENCH_JOB: remoteSpec,
  };
  try {
    await execFile(state.session, join(dir, spec.run ?? "run.py"), projectDir, env, Number(jobSpec.timeoutSec) + 120, {
      onLog,
      signal: input.signal,
    });
  } finally {
    // 失败也要打 heartbeat：人在看，不该被当成空闲
    await execFile(state.session, join(dir, "heartbeat.py"), projectDir, env, 120, { onLog }).catch(() => {});
    touchColabActivity(projectDir);
  }

  const local = join(projectDir, ".filmbench", "tmp", `${input.jobId}.mp4`);
  const down = await runColab(["download", remoteOut, local, "--session", state.session], projectDir, { onLog });
  if (down.code !== 0) throw new Error(`下载产物失败：${down.err.slice(-400)}`);
  return { path: local, remoteOut };
}

export async function colabDown(options: { projectDir: string; onLog?: (line: string) => void }): Promise<boolean> {
  const state = readColabState(options.projectDir);
  if (!state) return false;
  await runColab(["stop", "--session", state.session], options.projectDir, { onLog: options.onLog });
  const left = await listColabSessions();
  clearColabState(options.projectDir);
  options.onLog?.(left.includes(state.session) ? `会话 ${state.session} 仍在列表里，请手动确认` : `会话 ${state.session} 已停止`);
  return !left.includes(state.session);
}

export function colabIdleMinutes(projectDir: string): number | null {
  const state = readColabState(projectDir);
  if (!state) return null;
  return (Date.now() - Date.parse(state.lastActiveAt)) / 60000;
}

export async function colabReap(options: {
  projectDir: string;
  idleMinutes?: number;
  onLog?: (line: string) => void;
}): Promise<{ stopped: boolean; idle: number | null }> {
  const state = readColabState(options.projectDir);
  if (!state) return { stopped: false, idle: null };
  const idle = (Date.now() - Date.parse(state.lastActiveAt)) / 60000;
  const limit = options.idleMinutes ?? state.idleMinutes ?? IDLE_DEFAULT;
  if (idle < limit) return { stopped: false, idle };
  options.onLog?.(`会话空闲 ${idle.toFixed(0)} 分钟 ≥ ${limit}，停止`);
  await colabDown({ projectDir: options.projectDir, onLog: options.onLog });
  return { stopped: true, idle };
}

export async function colabStatus(projectDir: string): Promise<{
  state: ColabState | null;
  alive: boolean;
  idleMinutes: number | null;
  usage: string[];
}> {
  const state = readColabState(projectDir);
  const alive = state ? (await listColabSessions()).includes(state.session) : false;
  const usage = cleanLines((await runColab(["usage"], projectDir)).out).slice(0, 6);
  return { state, alive, idleMinutes: colabIdleMinutes(projectDir), usage };
}
