import type { Service } from "@filmbench/core";
import { toolSpecs } from "@filmbench/tools";

/**
 * 内置 agent：pi 核心跑在 engine 进程里，工具就是 @filmbench/tools 那张表。
 * 没有安装 pi 时不假装能跑——直接给出下一步命令。
 */
export async function runAgent(service: Service, dir: string, prompt: string): Promise<void> {
  void service;
  let sdk: any;
  try {
    sdk = await import("@earendil-works/pi-coding-agent");
  } catch {
    process.stderr.write(
      [
        "未安装 pi 核心，无法启动内置 agent。",
        "  bun add @earendil-works/pi-coding-agent",
        "也可以不用内置 agent：`filmbench mcp` 把同一套工具接到你现有的 MCP 客户端。",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const specs = toolSpecs(dir);
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir,
    extensionFactories: [
      (pi: any) => {
        for (const spec of specs) {
          pi.registerTool({
            name: spec.name,
            label: spec.label,
            description: spec.description,
            parameters: spec.parameters,
            promptSnippet: spec.description,
            execute: async (args: Record<string, unknown>) => {
              try {
                const result = await spec.execute(args ?? {});
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
              } catch (err) {
                return { content: [{ type: "text", text: `错误：${(err as Error).message}` }], isError: true };
              }
            },
          });
        }
      },
    ],
  });
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    cwd: dir,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(dir),
  });

  try {
    session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") {
        process.stderr.write(`\n[tool] ${event.toolName}\n`);
      }
    });
    const usage = await session.prompt(prompt);
    process.stdout.write("\n");
    if (usage?.usage?.cost?.total) {
      process.stderr.write(`\n本次模型花费 ${usage.usage.cost.total.toFixed(4)} ${usage.usage.cost.currency ?? "USD"}\n`);
    }
  } finally {
    session.dispose();
  }
}
