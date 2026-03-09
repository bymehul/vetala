import type { ToolCall, ToolContext, ToolResult, ToolSpec } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(tool: ToolSpec): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  toSarvamTools() {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema
      }
    }));
  }

  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.function.name);

    if (!tool) {
      return {
        summary: `Unknown tool: ${toolCall.function.name}`,
        content: `Tool ${toolCall.function.name} is not registered.`,
        isError: true
      };
    }

    let rawArgs: unknown;

    try {
      rawArgs = parseToolArguments(toolCall.function.arguments);
    } catch (error) {
      return {
        summary: `Invalid arguments for ${toolCall.function.name}`,
        content: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }

    const result = await tool.execute(rawArgs, context);

    const referencedPaths = new Set([
      ...(result.referencedFiles ?? []),
      ...(result.readFiles ?? [])
    ]);

    for (const targetPath of referencedPaths) {
      await context.approvals.registerReference(targetPath);
    }

    for (const targetPath of result.readFiles ?? []) {
      await context.reads.registerRead(targetPath);
    }

    return result;
  }
}

function parseToolArguments(rawArguments: string): unknown {
  if (!rawArguments.trim()) {
    return {};
  }

  return JSON.parse(rawArguments);
}
