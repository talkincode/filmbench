import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toolSpecs } from "@filmbench/tools";
import type { Service } from "@filmbench/core";

/**
 * 全功能 stdio MCP：工具表来自 @filmbench/tools，与内置 agent 完全同源。
 * stdout 归协议栈所有，日志一律走 stderr。
 */
export async function serveStdio(service: Service, dir: string): Promise<void> {
  const server = new McpServer(
    { name: "filmbench", version: "0.0.1" },
    { capabilities: { tools: {}, resources: {} } },
  );

  for (const spec of toolSpecs(dir)) {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = (spec.parameters.properties ?? {}) as Record<string, { type?: string; description?: string }>;
    const required = new Set<string>((spec.parameters.required as string[] | undefined) ?? []);
    for (const [key, prop] of Object.entries(props)) {
      const base = prop.type === "number" ? z.number() : prop.type === "boolean" ? z.boolean() : z.string();
      shape[key] = required.has(key) ? base : base.optional();
    }

    server.registerTool(
      spec.name,
      {
        title: spec.label,
        description: spec.description,
        inputSchema: shape,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await spec.execute(args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (err as Error).message }],
          };
        }
      },
    );
  }

  server.registerResource(
    "film",
    "filmbench://film",
    { title: "Film 意图文档", mimeType: "application/json", description: "当前修订的 Intent 投影（JSON 是规范形式）" },
    async () => ({
      contents: [
        {
          uri: "filmbench://film",
          mimeType: "application/json",
          text: JSON.stringify(service.exportFilm(), null, 2),
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.on("SIGTERM", resolve);
    process.on("SIGINT", resolve);
  });
}
