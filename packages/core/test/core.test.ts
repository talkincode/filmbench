import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, build, compile, lintPrompt, projectStoryboard, reconcileOrphans, runJobs, shotDetail, submit, summarize } from "../src/index.ts";
import { builtinProviders } from "../../providers/src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "filmbench-"));
const registry = builtinProviders();
const hasFfmpeg = Boolean(Bun.which("ffmpeg"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function project(name: string) {
  const sub = join(dir, name);
  const svc = Service.open(sub);
  svc.createProject({ name: "p", title: "T", format: { width: 320, height: 180, fps: 30 }, budget: { currency: "USD", limit: 5 } });
  svc.addShot({
    id: "shot-a",
    title: "A",
    durationFrames: 30,
    intent: { description: "d", action: "", prompt: "p" },
    binder: { provider: "filmbench/colorcard", task: "clip", params: {} },
    subjects: [],
    references: [],
    dependsOn: [],
  });
  return { svc, sub };
}

describe("事件日志与单写路径", () => {
  test("同一 operationId 重放不产生第二条事件", () => {
    const { svc } = project("idem");
    const a = svc.patchShot("shot-a", { title: "B" }, { opid: "op-1" });
    const b = svc.patchShot("shot-a", { title: "B" }, { opid: "op-1" });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(svc.head().seq).toBe(a.event.seq);
    svc.close();
  });

  test("重写同样的值不产生新事件（幂等写入）", () => {
    const { svc } = project("noop-patch");
    const before = svc.head().seq;
    const r = svc.patchShot("shot-a", { title: "A" }); // 与当前 title 相同
    expect(r.replayed).toBe(true);
    expect(svc.head().seq).toBe(before);
    svc.close();
  });

  test("baseRevision 不匹配时拒绝写入，状态不变", () => {
    const { svc } = project("conflict");
    const head = svc.head().seq;
    svc.patchShot("shot-a", { title: "B" });
    expect(() => svc.patchShot("shot-a", { title: "C" }, { base: head })).toThrow(/基础修订不匹配/);
    expect(svc.state().shots[0].title).toBe("B");
    svc.close();
  });

  test("改一个事件文件会被哈希链检出", () => {
    const { svc, sub } = project("tamper");
    const file = join(sub, "journal", "events", readdirSync(join(sub, "journal", "events"))[0]);
    const event = JSON.parse(readFileSync(file, "utf8"));
    event.payload.title = "篡改";
    writeFileSync(file, JSON.stringify(event));
    const result = svc.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("哈希不匹配");
    svc.close();
  });

  test("索引是缓存：删库重建后状态一致", () => {
    const { svc, sub } = project("reindex");
    svc.patchShot("shot-a", { intent: { prompt: "新 prompt" } });
    const before = svc.state().head.seq;
    svc.close();
    rmSync(join(sub, ".filmbench"), { recursive: true, force: true });
    const again = Service.open(sub);
    again.reindex();
    expect(again.state().head.seq).toBe(before);
    expect(again.state().shots[0].intent.prompt).toBe("新 prompt");
    again.close();
  });
});

describe("参考图与 prompt 规范", () => {
  test("参考图超过 5 张直接拒绝（协议层）", () => {
    const { svc } = project("refs-max");
    const refs = Array.from({ length: 6 }, (_, i) => ({ asset: `asset-${i}`, role: "other" as const }));
    expect(() => svc.patchShot("shot-a", { references: refs })).toThrow(/最多 5 张/);
    svc.close();
  });

  test("缺 prompt 的 imagine 作业在提交前被拒，不浪费一次付费调用", () => {
    const { svc } = project("prompt-missing");
    svc.close();
    const sub = join(dir, "prompt-missing");
    rmSync(sub, { recursive: true, force: true });
    const s2 = Service.open(sub);
    s2.createProject({ name: "p", title: "T", format: { width: 320, height: 180, fps: 30 } });
    s2.addShot({
      id: "shot-a",
      title: "A",
      durationFrames: 30,
      intent: { description: "", action: "", prompt: "" },
      binder: { provider: "imagine", task: "image", params: { model: "m" } },
      subjects: [],
      references: [],
      dependsOn: [],
    });
    expect(() => submit(s2, registry, { shot: "shot-a" })).toThrow(/缺少 图片 prompt/);
    expect(s2.state().jobs.size).toBe(0);
    s2.close();
  });

  test("prompt 规则：过短、文字泄漏、参考图全 other、有主体无身份图", () => {
    const { svc } = project("prompt-rules");
    const provider = registry.get("imagine")!;
    const shot = svc.state().shots[0];

    const thin = lintPrompt({ ...shot, intent: { ...shot.intent, prompt: "a cat" } }, provider);
    expect(thin.map((i) => i.id)).toContain("prompt.thin");

    const leak = lintPrompt(
      { ...shot, intent: { ...shot.intent, prompt: "street at night with a 字幕 overlay, 35mm, cinematic lighting" } },
      provider,
    );
    expect(leak.map((i) => i.id)).toContain("prompt.text-leak");

    const refs = lintPrompt(
      {
        ...shot,
        intent: { ...shot.intent, prompt: "a wide riverside shot at night, wet asphalt, teal light" },
        subjects: [{ id: "hero", revision: 1 }],
        references: [{ asset: "asset-x", role: "other" }],
      },
      provider,
    );
    expect(refs.map((i) => i.id)).toEqual(expect.arrayContaining(["reference.roles", "reference.identity"]));
    svc.close();
  });
});

describe("作业、预算与账本", () => {
  test("预算不足时作业被拒，且不产生花费", () => {
    const { svc } = project("budget");
    svc.close();
    const sub = join(dir, "budget");
    rmSync(sub, { recursive: true, force: true });
    const svc2 = Service.open(sub);
    svc2.createProject({
      name: "p2",
      title: "T",
      format: { width: 320, height: 180, fps: 30 },
      budget: { currency: "USD", limit: 0.01 },
    });
    svc2.addShot({
      id: "shot-a",
      title: "A",
      durationFrames: 30,
      intent: { description: "", action: "", prompt: "p" },
      binder: { provider: "imagine", task: "image", params: { unitPrice: 1, model: "m" } },
      subjects: [],
      references: [],
      dependsOn: [],
    });
    const r = submit(svc2, registry, { shot: "shot-a" });
    expect(r.phase).toBe("rejected");
    expect(svc2.state().ledger.length).toBe(0);
    expect(svc2.state().jobs.get(r.jobId)?.phase).toBe("rejected");
    svc2.close();
  });

  test("执行作业：内容寻址落盘、花费入账", async () => {
    if (!hasFfmpeg) return;
    const { svc, sub } = project("run");
    const submitted = submit(svc, registry, { shot: "shot-a" });
    expect(submitted.phase).toBe("requested");
    const results = await runJobs(svc, registry);
    expect(results[0].ok).toBe(true);
    const state = svc.state();
    const produce = state.shots[0].produce!;
    expect(produce).toBeDefined();
    expect(existsSync(join(sub, produce.path))).toBe(true);
    expect(produce.bytes).toBeGreaterThan(0);
    expect(summarize(state).spent).toBe(0);
    svc.close();
  });
});

describe("执行队列的边界", () => {
  test("执行前重新核对预算：排队期间钱花掉了，作业被拒而不是透支", async () => {
    const { svc } = project("run-budget");
    svc.close();
    const sub = join(dir, "run-budget");
    rmSync(sub, { recursive: true, force: true });
    const s2 = Service.open(sub);
    s2.createProject({ name: "p", title: "T", format: { width: 320, height: 180, fps: 30 }, budget: { currency: "USD", limit: 2 } });
    s2.addShot({
      id: "shot-a",
      title: "A",
      durationFrames: 30,
      intent: { description: "", action: "", prompt: "a wide river at night, wet asphalt, teal light" },
      binder: { provider: "imagine", task: "image", params: { model: "m", unitPrice: 1 } },
      subjects: [],
      references: [],
      dependsOn: [],
    });
    const r = submit(s2, registry, { shot: "shot-a" });
    expect(r.phase).toBe("requested");
    // 排队之后，别的开销把预算花掉
    s2.append("cost.recorded", {
      kind: "api",
      provider: "imagine",
      units: "image",
      unitPrice: 2,
      amount: 2,
      currency: "USD",
      priceUnknown: false,
    });
    const outcomes = await runJobs(s2, registry);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].reason).toContain("预算不足");
    expect(s2.state().jobs.get(r.jobId)?.phase).toBe("rejected");
    s2.close();
  });

  test("进程中断留下的 running 作业会被清理，不会永远挂着", () => {
    const { svc } = project("orphan");
    svc.append("job.requested", {
      jobId: "job-x",
      shot: "shot-a",
      provider: "filmbench/colorcard",
      task: "clip",
      params: {},
      estimate: { amount: 0, currency: "USD", units: "clip", priceUnknown: false },
      inputsHash: "0".repeat(64),
    });
    svc.append("job.started", { jobId: "job-x" });
    expect(svc.state().jobs.get("job-x")?.phase).toBe("running");
    const n = reconcileOrphans(svc);
    expect(n).toBe(1);
    expect(svc.state().jobs.get("job-x")?.phase).toBe("failed");
    expect(svc.state().jobs.get("job-x")?.reason).toContain("进程中断");
    svc.close();
  });
});

describe("编译与投影", () => {
  test("缺产物时编译给出明确 issue，而不是等到 ffmpeg 报错", () => {
    const { svc } = project("compile-missing");
    const { ir, issues } = compile(svc.state());
    expect(ir).toBeNull();
    expect(issues.map((i) => i.code)).toContain("missing-output");
    svc.close();
  });

  test("有产物但没有选定时不能出片（选片不是默认生效）", () => {
    if (!hasFfmpeg) return;
    const { svc, sub } = project("compile-nosel");
    submit(svc, registry, { shot: "shot-a" });
    return runJobs(svc, registry).then(() => {
      const { ir, issues } = compile(svc.state(), sub);
      expect(ir).toBeNull();
      expect(issues.map((i) => i.code)).toContain("no-selection");
      svc.close();
    });
  });

  test("同一状态两次编译得到逐字节相同的 IR", async () => {
    if (!hasFfmpeg) return;
    const { svc, sub } = project("compile-ir");
    submit(svc, registry, { shot: "shot-a" });
    await runJobs(svc, registry);
    const produce = svc.state().shots[0].produce!;
    svc.setSelection("shot-a", "video", produce.asset);
    svc.decideReview("shot-a", produce.asset, "approved");
    const a = compile(svc.state(), sub);
    const b = compile(svc.state(), sub);
    expect(a.ir).not.toBeNull();
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.ir!.clips[0].durationFrames).toBe(30);
    const built = await build(svc, {});
    expect(built.durationFrames).toBe(30);
    expect(existsSync(built.out)).toBe(true);
    svc.close();
  });

  test("分镜详情把意图、产物、作业、花费、事件、检查项串成一个对象", async () => {
    if (!hasFfmpeg) return;
    const { svc } = project("detail");
    svc.proposeSubject({ id: "hero", name: "主角", revision: 1 });
    svc.patchShot("shot-a", { subjects: [{ id: "hero", revision: 1 }] });
    submit(svc, registry, { shot: "shot-a" });
    await runJobs(svc, registry);
    const produce = svc.state().shots[0].produce!;
    svc.setSelection("shot-a", "video", produce.asset);
    svc.decideReview("shot-a", produce.asset, "approved");

    const d = shotDetail(svc, registry, "shot-a");
    expect(d.shot.order).toBe(1);
    expect(d.produce?.exists).toBe(true);
    expect(d.produce?.absPath.endsWith(".mp4")).toBe(true);
    expect(d.jobs.length).toBe(1);
    expect(d.jobs[0].phase).toBe("done");
    expect(d.shot.subjects[0].approved).toBe(false);
    expect(d.cost.calls).toBe(1);
    expect(d.events.map((e) => e.op)).toContain("job.completed");
    expect(d.shot.checks.some((c) => c.id === "artifact.missing" && c.status === "pass")).toBe(true);
    expect(d.shot.selected).toBe(produce.asset);
    expect(d.revision.seq).toBeGreaterThan(0);
    svc.close();
  });

  test("确定性 provider 重跑产出同一素材时，候选按 asset 去重（不会出现两个已选）", async () => {
    if (!hasFfmpeg) return;
    const { svc } = project("candidate-dedupe");
    submit(svc, registry, { shot: "shot-a" });
    await runJobs(svc, registry);
    const first = svc.state().shots[0].produce!;
    svc.setSelection("shot-a", "video", first.asset);

    submit(svc, registry, { shot: "shot-a" });
    await runJobs(svc, registry);
    const second = svc.state().shots[0].produce!;
    expect(second.asset).toBe(first.asset); // colorcard 确定性：同输入同字节

    const doc = projectStoryboard(svc, registry);
    const cands = doc.shots[0].candidates ?? [];
    expect(cands.length).toBe(1);
    expect(cands.filter((c) => c.review === "selected").length).toBe(1);
    svc.close();
  });

  test("故事板投影把缺产物、未批准主体、未审阅选定算成检查项", async () => {
    const { svc } = project("projection");
    svc.proposeSubject({ id: "hero", name: "主角", revision: 1 });
    svc.patchShot("shot-a", { subjects: [{ id: "hero", revision: 1 }] });
    const doc = projectStoryboard(svc, registry);
    const shot = doc.shots[0];
    const ids = shot.checks.map((c) => c.id);
    expect(ids).toContain("artifact.missing");
    expect(ids).toContain("reference.unapproved");

    if (hasFfmpeg) {
      submit(svc, registry, { shot: "shot-a" });
      await runJobs(svc, registry);
      const after = projectStoryboard(svc, registry).shots[0];
      expect(after.produces[0].exists).toBe(true);
      const failing = after.checks.filter((c) => c.status === "fail").map((c) => c.id);
      expect(failing).not.toContain("artifact.missing");
      expect(after.checks.some((c) => c.id === "artifact.missing" && c.status === "pass")).toBe(true);
    }
    svc.close();
  });
});
