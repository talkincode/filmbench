import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCapabilities, readWorkflowSpec } from "../src/workflow.ts";

function spec(overrides: Record<string, unknown> = {}) {
  return {
    schema: "filmbench/workflow/v1",
    name: "h3-i2v",
    title: "H3",
    gpu: "A100",
    defaults: { width: 768, height: 1024, length: 124, fps: 24, steps: 24, seed: 7101 },
    capabilities: { firstFrame: true, lastFrame: false },
    models: ["diffusion_models/x.safetensors"],
    ...overrides,
  };
}

describe("workflow 定义", () => {
  test("合法定义解析出 defaults 与 capabilities 默认值", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "workflow.json"), JSON.stringify(spec()));
    const parsed = readWorkflowSpec(dir);
    expect(parsed.defaults.width).toBe(768);
    expect(parsed.capabilities.firstFrame).toBe(true);
    expect(parsed.capabilities.referenceImages).toBe(false);
    expect(parsed.run).toBe("run.py");
  });

  test("schema 或 gpu 不合法时带字段路径报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "workflow.json"), JSON.stringify(spec({ gpu: "V100" })));
    expect(() => readWorkflowSpec(dir)).toThrow(/gpu/);
  });

  test("镜头给了工作流不支持的能力时拒绝，不静默丢输入", () => {
    const parsed = { ...spec(), capabilities: { firstFrame: true, lastFrame: false, referenceImages: false, referenceVideos: false, controlVideo: false } } as any;
    expect(() => assertCapabilities(parsed, { lastFrame: true })).toThrow(/尾帧/);
    expect(() => assertCapabilities(parsed, { referenceImages: true })).toThrow(/参考图/);
    expect(() => assertCapabilities(parsed, { firstFrame: true })).not.toThrow();
  });
});
