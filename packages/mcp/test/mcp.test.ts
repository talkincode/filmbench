import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Service } from "@filmbench/core";

const dir = mkdtempSync(join(tmpdir(), "filmbench-mcp-"));
const cli = resolve(import.meta.dir, "../../cli/src/cli.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("stdio MCP", () => {
  test("外部客户端能列出工具、读状态、写镜头，且与 GUI/CLI 同一份状态", async () => {
    const svc = Service.open(dir);
    svc.createProject({ name: "mcp", title: "MCP 项目", format: { width: 320, height: 180, fps: 30 } });
    svc.close();

    const client = new Client({ name: "filmbench-test", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      cwd: dir,
      stderr: "pipe",
    });
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toContain("project_state");
      expect(names).toContain("shot_add");
      expect(names).toContain("job_submit");
      expect(names).toContain("render_build");
      expect(names).toContain("journal_verify");

      const read = await client.callTool({ name: "project_state", arguments: {} });
      const first = JSON.parse((read.content as { text: string }[])[0].text);
      expect(first.project.name).toBe("mcp");
      expect(first.shots).toEqual([]);

      const added = await client.callTool({
        name: "shot_add",
        arguments: {
          id: "shot-x",
          title: "外部加进来的镜头",
          durationFrames: 30,
          provider: "filmbench/colorcard",
          task: "clip",
          prompt: "p",
        },
      });
      if (added.isError) console.error("MCP 错误:", JSON.stringify(added.content));
      expect(added.isError).toBeFalsy();

      // 写入必须落在同一条事件日志上
      const reopened = Service.open(dir);
      expect(reopened.state().shots.map((s) => s.id)).toEqual(["shot-x"]);
      expect(reopened.verify().ok).toBe(true);
      reopened.close();

      const verify = await client.callTool({ name: "journal_verify", arguments: {} });
      const verified = JSON.parse((verify.content as { text: string }[])[0].text);
      expect(verified.ok).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
