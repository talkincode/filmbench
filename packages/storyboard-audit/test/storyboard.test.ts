import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { derive } from "../src/audit.ts";
import { renderDocument } from "../src/render.ts";
import type { StoryboardDoc } from "../src/types.ts";

const HERE = resolve(import.meta.dir, "..");
const fixture = (): StoryboardDoc =>
  JSON.parse(readFileSync(join(HERE, "fixtures/demo.storyboard.json"), "utf8")) as StoryboardDoc;
const assets = () => ({
  css: readFileSync(join(HERE, "src/style.css"), "utf8"),
  client: readFileSync(join(HERE, "src/client.js"), "utf8"),
});

describe("审计判定", () => {
  test("阻塞与缺产物是正交的两件事，统计不能合并", () => {
    const { totals } = derive(fixture());
    // 05/06/08/10 有 blocker 且没有产物；04 有产物但已过期
    expect(totals.blocked).toBe(4);
    expect(totals.missingArtifact).toBe(4);
    expect(totals.flaggedStale).toBe(1);
    expect(totals.ready).toBe(7);
    expect(totals.shots).toBe(totals.ready + totals.blocked + totals.missing + totals.stale);
  });

  test("时长合计与声明不一致会被记成系统级发现", () => {
    const { findings } = derive(fixture());
    const d = findings.find((f) => f.check === "timeline.duration");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("warning");
    expect(d!.detail).toContain("1635");
    expect(d!.detail).toContain("1620");
  });

  test("音轨越界会被记成发现，而不是静默裁掉", () => {
    const { findings } = derive(fixture());
    const audio = findings.find((f) => f.check === "timeline.audio");
    expect(audio).toBeDefined();
    expect(audio!.detail).toContain("sfx-impact");
  });

  test("未登记的检查项不会被当成通过", () => {
    const doc = fixture();
    doc.shots[0].checks = [{ id: "artifact.brand-new-rule", status: "fail" }];
    const shot = derive(doc).shots[0];
    expect(shot.findings.map((f) => f.check)).toContain("artifact.brand-new-rule");
    expect(shot.findings[0].severity).toBe("note");
  });

  test("价格未知不参与金额汇总，单独计数", () => {
    const { totals } = derive(fixture());
    expect(totals.unknownPriceShots).toBe(1);
    // 09 号价格未知 → 不计入 est/actual，两侧加总都不含它
    const withUnknown = derive(fixture()).shots.find((s) => s.id === "shot-009")!;
    expect(withUnknown.cost?.priceUnknown).toBe(true);
    expect(totals.costActual).toBeCloseTo(4.37, 2);
  });

  test("检查项全通过但缺产物时，状态仍是缺产物", () => {
    const doc = fixture();
    const shot = doc.shots.find((s) => s.id === "shot-005")!;
    shot.checks = [];
    const derived = derive(doc).shots.find((s) => s.id === "shot-005")!;
    expect(derived.state).toBe("missing");
  });
});

describe("渲染", () => {
  test("确定性：同一输入渲染两次逐字节相同", () => {
    const a = renderDocument(fixture(), assets());
    const b = renderDocument(fixture(), assets());
    expect(a).toBe(b);
  });

  test("单文件：除 SVG 命名空间外不含任何外部资源引用", () => {
    const html = renderDocument(fixture(), assets());
    const external = html.match(/https?:\/\/[^"')\s]+/g) ?? [];
    expect(external.filter((u) => !u.startsWith("http://www.w3.org/"))).toEqual([]);
    expect(html).not.toContain("<link ");
    expect(html).not.toContain("src=\"http");
  });

  test("每个镜头都有卡片、序号与筛选标记，网格顺序与播放顺序一致", () => {
    const doc = fixture();
    const html = renderDocument(doc, assets());
    for (const [i, shot] of doc.shots.entries()) {
      expect(html).toContain(`id="${shot.id}"`);
      expect(html).toContain(`data-order="${i + 1}"`);
    }
    const orders = [...html.matchAll(/data-order="(\d+)"/g)].map((m) => Number(m[1]));
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const idx = doc.shots.map((s) => html.indexOf(`id="${s.id}"`));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  test("底账列出每一条阻塞，且给出可跳转的镜头锚点", () => {
    const html = renderDocument(fixture(), assets());
    const { totals } = derive(fixture());
    const blockedRows = [...html.matchAll(/data-sev="blocker">■ blocker/g)].length;
    expect(blockedRows).toBe(totals.blockers);
    expect(html).toContain('data-jump="shot-005"');
  });
});

describe("CLI", () => {
  const run = (args: string[]) =>
    Bun.spawnSync(["bun", join(HERE, "src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });

  test("拒绝非法输入而不是渲染一个假的通过", () => {
    const dir = mkdtempSync(join(tmpdir(), "sba-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ apiVersion: "v0", project: {}, shots: [] }));
    const r = run(["--in", bad, "--out", join(dir, "x.html")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("apiVersion");
  });

  test("--exit-on-blocker 在有阻塞时退出 2，并且仍然写出故事板", () => {
    const dir = mkdtempSync(join(tmpdir(), "sba-"));
    const out = join(dir, "nested/storyboard.html");
    const r = run(["--in", join(HERE, "fixtures/demo.storyboard.json"), "--out", out, "--exit-on-blocker"]);
    expect(r.exitCode).toBe(2);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("审计故事板");
  });

  test("--json 输出机器可读汇总", () => {
    const dir = mkdtempSync(join(tmpdir(), "sba-"));
    const out = join(dir, "storyboard.html");
    const r = run(["--in", join(HERE, "fixtures/demo.storyboard.json"), "--out", out, "--json"]);
    expect(r.exitCode).toBe(0);
    const summary = JSON.parse(r.stdout.toString());
    expect(summary.shots).toBe(12);
    expect(summary.findings.blockers).toBe(4);
    expect(summary.state.missingArtifact).toBe(4);
  });
});
