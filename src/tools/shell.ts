import type { ToolContext, ToolSpec } from "../types.js";
import { runShellCommand } from "../process-utils.js";

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "date",
  "env",
  "find",
  "git",
  "head",
  "ls",
  "node",
  "npm",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "wc",
  "which"
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set(["branch", "diff", "log", "rev-parse", "show", "status"]);

export function createShellTools(): ToolSpec[] {
  return [runShellTool, bashTool];
}

const runShellTool: ToolSpec = {
  name: "run_shell",
  description: "Run a shell command in the workspace using the platform-default shell. Read-only commands are auto-approved; everything else requires approval.",
  jsonSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute."
      }
    },
    required: ["command"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const command = requiredString(args.command, "command");

    if (!isReadOnlyCommand(command)) {
      const approved = await context.approvals.requestApproval({
        kind: "run_shell",
        key: `run_shell:${command}`,
        label: `Allow shell command?\n${command}`
      });

      if (!approved) {
        return {
          summary: `Shell command denied: ${command}`,
          content: `Approval denied for shell command:\n${command}`,
          isError: true
        };
      }
    }

    const result = await runShellCommand(command, { cwd: context.workspaceRoot });
    const rendered = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

    return {
      summary: `Command finished with exit code ${result.exitCode ?? "null"}`,
      content: rendered || "(no output)",
      isError: (result.exitCode ?? 1) !== 0
    };
  }
};

const bashTool: ToolSpec = {
  ...runShellTool,
  name: "bash",
  description: "Alias for run_shell. Run a shell command in the workspace using the platform-default shell."
};

function isReadOnlyCommand(command: string): boolean {
  if (/[|&;><`$()]/.test(command)) {
    return false;
  }

  const parts = command.trim().split(/\s+/).filter(Boolean);
  const executable = parts[0];

  if (!executable || !READ_ONLY_COMMANDS.has(executable)) {
    return false;
  }

  if (executable === "git") {
    const subcommand = parts[1];
    return typeof subcommand === "string" && ALLOWED_GIT_SUBCOMMANDS.has(subcommand);
  }

  return true;
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool arguments must be a JSON object.");
}

function requiredString(value: unknown, key: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing string argument: ${key}`);
}
