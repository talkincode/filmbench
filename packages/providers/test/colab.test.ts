import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colabDown, colabReap, colabSessions, colabStatus, colabUp, readColabState } from "../src/colab.ts";

/**
 * 用假的 colab CLI 验证会话生命周期：建一次、复用、工作流变了才重建、空闲了停。
 * 不打真实 Colab，也不花 CU。
 */
const root = mkdtempSync(join(tmpdir(), "fb-colab-test-"));
const binDir = join(root, "bin");
const logFile = join(root, "calls.log");
const sessionsFile = join(root, "sessions.txt");
const dummy = join(root, "out.mp4");
const project = join(root, "project");
const repoWorkflows = join(import.meta.dir, "../../../workflows");

let oldPath = "";
let oldEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(project, ".filmbench"), { recursive: true });
  writeFileSync(dummy, "fake-mp4");
  // 项目级工作流副本：改副本不会污染仓库
  cpSync(join(repoWorkflows, "comfy-h3"), join(project, "workflows", "comfy-h3"), { recursive: true });
  writeFileSync(sessionsFile, "[?] gpu-l4-s-foreign | Hardware: L4 | Shape: Standard | Variant: GPU\n");

  const fake = `#!/bin/sh
echo "$@" >> "${logFile}"
case "$1" in
  sessions) cat "${sessionsFile}" ;;
  new) echo "$3" >> "${sessionsFile}" ;;
  stop) grep -v "^$3$" "${sessionsFile}" > "${sessionsFile}.tmp" || true; mv "${sessionsFile}.tmp" "${sessionsFile}" ;;
  download) cp "${dummy}" "$3" ;;
  exec)
    case "$*" in
      *check.py*) echo "DONE 0"; echo "__FB_OK__" ;;
      *) echo "__FB_OK__" ;;
    esac ;;
esac
exit 0
`;
  writeFileSync(join(binDir, "colab"), fake);
  chmodSync(join(binDir, "colab"), 0o755);

  oldPath = process.env.PATH ?? "";
  oldEnv = { PATH: process.env.PATH, FILMBENCH_REMOTE: process.env.FILMBENCH_REMOTE, FILMBENCH_COLAB_BIN: process.env.FILMBENCH_COLAB_BIN };
  process.env.PATH = `${binDir}:${oldPath}`;
  process.env.FILMBENCH_COLAB_BIN = join(binDir, "colab");
  process.env.FILMBENCH_COLAB_POLL_MS = "20";
});

afterAll(() => {
  process.env.PATH = oldPath;
  process.env.FILMBENCH_REMOTE = oldEnv.FILMBENCH_REMOTE;
  process.env.FILMBENCH_COLAB_BIN = oldEnv.FILMBENCH_COLAB_BIN;
  rmSync(root, { recursive: true, force: true });
});

const calls = () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);

describe("会话列表解析", () => {
  test("认得 [名字] 与 [?] 两种行，并区分硬件", async () => {
    writeFileSync(
      sessionsFile,
      [
        "[?] gpu-l4-s-foreign | Hardware: L4 | Shape: Standard | Variant: GPU",
        "[fb-project-comfy-h3] gpu-l4-s-ass1a0-2ozk | Hardware: A100 | Shape: Standard | Variant: GPU",
        "[-] no sessions",
      ].join("\n"),
    );
    const list = await colabSessions();
    expect(list.map((s) => s.name)).toEqual(["gpu-l4-s-foreign", "fb-project-comfy-h3"]);
    expect(list[1].hardware).toBe("A100");
  });
});

describe("Colab 会话复用与空闲回收", () => {
  test("第一次 up：建会话、上传、解包、setup；第二次复用不重建", async () => {
    writeFileSync(logFile, "");
    const first = await colabUp({ projectDir: project, workflow: "comfy-h3" });
    expect(first.session.startsWith("fb-")).toBe(true);
    expect(first.idleMinutes).toBe(30);

    const log = calls();
    expect(log.filter((l) => l.startsWith("new ")).length).toBe(1);
    expect(log.some((l) => l.includes("upload") && l.includes("pkg.tar.gz"))).toBe(true);
    expect(log.some((l) => l.includes("bootstrap.py"))).toBe(true);
    expect(log.some((l) => l.includes("setup.py"))).toBe(true);
    expect(log.some((l) => l.includes("heartbeat.py"))).toBe(true);
    expect(readColabState(project)?.session).toBe(first.session);

    const second = await colabUp({ projectDir: project, workflow: "comfy-h3" });
    expect(second.session).toBe(first.session);
    expect(calls().filter((l) => l.startsWith("new ")).length).toBe(1);
  });

  test("工作流改了才重建会话", async () => {
    writeFileSync(logFile, "");
    writeFileSync(join(project, "workflows/comfy-h3/heartbeat.py"), "# touched\n", { flag: "a" });
    const next = await colabUp({ projectDir: project, workflow: "comfy-h3" });
    expect(calls().filter((l) => l.startsWith("stop ")).length).toBeGreaterThanOrEqual(1);
    expect(calls().filter((l) => l.startsWith("new ")).length).toBe(1);
    expect(next.workflowHash).not.toBe("");
  });

  test("空闲未到阈值不停；超过阈值只停本项目会话，别家的不动", async () => {
    const before = await colabReap({ projectDir: project, idleMinutes: 30 });
    expect(before.stopped).toBe(false);

    const stBefore = await colabStatus(project);
    expect(stBefore.others.map((s) => s.name)).toContain("gpu-l4-s-foreign");

    const after = await colabReap({ projectDir: project, idleMinutes: 0 });
    expect(after.stopped).toBe(true);
    expect(readColabState(project)).toBeNull();

    const stopped = calls().filter((l) => l.startsWith("stop "));
    const session = stBefore.state!.session;
    expect(stopped.every((l) => l.includes(session))).toBe(true);
    expect(stopped.some((l) => l.includes("gpu-l4-s-foreign"))).toBe(false);

    const st = await colabStatus(project);
    expect(st.state).toBeNull();
    expect(st.others.map((s) => s.name)).toContain("gpu-l4-s-foreign");
  });

  test("down 在没有会话时是安全的", async () => {
    expect(await colabDown({ projectDir: project })).toBe(false);
    expect(existsSync(join(project, ".filmbench/colab.json"))).toBe(false);
  });
});
