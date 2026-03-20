import path from "node:path";
import { access } from "node:fs/promises";
import type { ToolContext, ToolResult, ToolSpec, ToolVerification } from "../types.js";
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

const ALLOWED_GIT_SUBCOMMANDS = new Set(["blame", "branch", "cat-file", "diff", "log", "ls-files", "merge-base", "rev-parse", "show", "status"]);
const MAX_SHELL_TIMEOUT_MS = 300_000;

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
      },
      timeout_ms: {
        type: "integer",
        description: "Optional command timeout in milliseconds. Use this for slower builds/tests. Maximum 300000."
      }
    },
    required: ["command"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const command = requiredString(args.command, "command");
    const timeoutMs = optionalTimeoutMs(args.timeout_ms);

    if (!isReadOnlyCommand(command)) {
      let key = `run_shell:${command}`;
      if (command.match(/(^|\s*&&\s*)(npm|pnpm|yarn|bun)\s+(i|install|add)\b/)) {
        key = "run_shell:pkg_install";
      }

      const approved = await context.approvals.requestApproval({
        kind: "run_shell",
        key,
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

    const result = await runShellCommand(command, {
      cwd: context.workspaceRoot,
      ...(timeoutMs ? { timeoutMs } : {})
    });
    const verification = await detectShellVerification(command, context.workspaceRoot);
    const renderedLines = [result.stdout.trim(), result.stderr.trim()].filter(Boolean);
    if (verification && !verification.trusted && verification.reason) {
      renderedLines.unshift(`Verification note: ${verification.reason}`);
    }
    const rendered = renderedLines.join("\n");
    const summary = result.timedOut
      ? `Command timed out after ${timeoutMs ?? 30_000} ms`
      : result.signal
        ? `Command terminated by signal ${result.signal}`
        : `Command finished with exit code ${result.exitCode ?? "null"}`;

    return withVerification({
      summary,
      content: rendered || "(no output)",
      isError: result.timedOut || (result.exitCode ?? 1) !== 0
    }, verification, !result.timedOut && (result.exitCode ?? 1) === 0);
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

function optionalTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error("timeout_ms must be a positive integer.");
  }

  return Math.min(value, MAX_SHELL_TIMEOUT_MS);
}

async function detectShellVerification(command: string, workspaceRoot: string): Promise<Omit<ToolVerification, "passed"> | null> {
  const kind = classifyVerificationCommand(command);
  if (!kind) {
    return null;
  }

  const requestedCwd = extractRequestedWorkingDir(command, workspaceRoot);
  const scopePaths = [requestedCwd];
  const packageCommand = extractPackageManagerCommand(command);

  if (packageCommand) {
    const packageRoot = await findNearestPackageRoot(requestedCwd);
    if (packageRoot) {
      if (packageRoot !== requestedCwd && requestedCwd !== workspaceRoot) {
        return {
          kind,
          trusted: false,
          summary: `${kind} command`,
          scopePaths: [packageRoot],
          reason: `${packageCommand} resolved a package from ${packageRoot}, not the requested directory ${requestedCwd}. This may verify the wrong project.`
        };
      }
      return {
        kind,
        trusted: true,
        summary: `${kind} command`,
        scopePaths: [packageRoot]
      };
    }
  }

  return {
    kind,
    trusted: true,
    summary: `${kind} command`,
    scopePaths
  };
}

function classifyVerificationCommand(command: string): ToolVerification["kind"] | null {
  const normalized = command.trim().toLowerCase();

  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(normalized) || /\b(go test|cargo test|pytest|vitest|jest)\b/.test(normalized)) {
    return "tests";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(normalized) || /\b(build|compile)\b/.test(normalized)) {
    return "build";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(check|lint|typecheck)\b/.test(normalized) || /\b(tsc|check|analyze|lint)\b/.test(normalized)) {
    return "check";
  }

  return null;
}

function extractRequestedWorkingDir(command: string, workspaceRoot: string): string {
  const match = command.match(/^\s*cd\s+((?:'[^']*'|"[^"]*"|[^;&|])+)\s*&&/);
  if (!match?.[1]) {
    return workspaceRoot;
  }

  const raw = unquote(match[1].trim());
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  return path.resolve(workspaceRoot, raw);
}

function extractPackageManagerCommand(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  const match = normalized.match(/\b(npm|pnpm|yarn|bun)\b/);
  return match?.[1] ?? null;
}

async function findNearestPackageRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);

  while (true) {
    if (await exists(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function withVerification(
  result: ToolResult,
  verification: Omit<ToolVerification, "passed"> | null,
  passed: boolean
): ToolResult {
  if (!verification) {
    return result;
  }

  return {
    ...result,
    meta: {
      ...(result.meta ?? {}),
      verification: {
        ...verification,
        passed
      }
    }
  };
}
