import { describe, expect, test } from "bun:test";
import { colabReuseDecision, type ColabState } from "../src/colab.ts";

const base: ColabState = {
  session: "fb-demo-h3-i2v",
  phase: "ready",
  gpu: "A100",
  workflow: "h3-i2v",
  workflowHash: "hash-a",
  remoteDir: "/content/filmbench",
  persist: "/content/filmbench/persist",
  idleMinutes: 30,
  createdAt: "2026-10-29T00:00:00Z",
  lastActiveAt: "2026-10-29T00:00:00Z",
};

describe("colab 会话复用决策", () => {
  test("装完、会话活着、工作流没变 → 复用", () => {
    expect(colabReuseDecision(base, ["fb-demo-h3-i2v"], "hash-a")).toBe("reuse");
  });

  test("上次停在 provisioning → 续装，不重建（不然几十 GB 模型要重下）", () => {
    expect(colabReuseDecision({ ...base, phase: "provisioning" }, ["fb-demo-h3-i2v"], "hash-a")).toBe("resume");
  });

  test("没状态 → 重建", () => {
    expect(colabReuseDecision(null, ["fb-demo-h3-i2v"], "hash-a")).toBe("recreate");
  });

  test("会话已经死了 → 重建", () => {
    expect(colabReuseDecision(base, [], "hash-a")).toBe("recreate");
  });

  test("工作流定义变了 → 重建", () => {
    expect(colabReuseDecision(base, ["fb-demo-h3-i2v"], "hash-b")).toBe("recreate");
  });

  test("老状态没有 phase 字段 → 按 ready 处理", () => {
    const { phase, ...legacy } = base;
    expect(colabReuseDecision(legacy as ColabState, ["fb-demo-h3-i2v"], "hash-a")).toBe("reuse");
  });
});
