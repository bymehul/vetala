import type { ToolContext, ToolSpec } from "../types.js";
import { runExecFile } from "../process-utils.js";

export function createGitTools(): ToolSpec[] {
  return [gitStatusTool, gitDiffTool, gitLogTool, gitBlameTool, gitShowTool, gitBranchTool, gitStashTool];
}

const gitStatusTool: ToolSpec = {
  name: "git_status",
  description:
    "Return the current git status for the workspace repository, including branch tracking info, staged/unstaged changes, and untracked files.",
  jsonSchema: {
    type: "object",
    properties: {
      showUntracked: {
        type: "boolean",
        description: "Whether to show untracked files. Defaults to true."
      },
      porcelain: {
        type: "boolean",
        description: "Use porcelain (machine-readable) format. Defaults to false."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const showUntracked = args.showUntracked === false ? "no" : "all";
    const format = args.porcelain === true ? ["--porcelain=v2", "--branch"] : ["--short", "--branch"];
    const result = await runExecFile(
      "git",
      ["status", ...format, `--untracked-files=${showUntracked}`],
      { cwd: context.workspaceRoot }
    );
    return formatGitResult("git status", result.stdout, result.stderr, result.exitCode);
  }
};

const gitDiffTool: ToolSpec = {
  name: "git_diff",
  description:
    "Return the current git diff or a diff against a specific ref. Supports staged diffs, stat summaries, and path filtering.",
  jsonSchema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "Optional git ref (branch, tag, commit SHA) to diff against."
      },
      staged: {
        type: "boolean",
        description: "If true, show staged (cached) changes instead of unstaged. Defaults to false."
      },
      stat: {
        type: "boolean",
        description: "If true, show a diffstat summary instead of full patch. Defaults to false."
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of file paths to restrict the diff to."
      },
      contextLines: {
        type: "integer",
        description: "Number of context lines around each change. Defaults to 3."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const ref = typeof args.ref === "string" && args.ref.length > 0 ? args.ref : undefined;
    const staged = args.staged === true;
    const stat = args.stat === true;
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
    const contextLines =
      typeof args.contextLines === "number" && Number.isInteger(args.contextLines) && args.contextLines >= 0
        ? args.contextLines
        : 3;

    const command = ["diff", "--no-ext-diff", `-U${contextLines}`];
    if (staged) command.push("--cached");
    if (stat) command.push("--stat");
    if (ref) command.push(ref);
    if (paths.length > 0) command.push("--", ...paths);

    const result = await runExecFile("git", command, { cwd: context.workspaceRoot });
    return formatGitResult("git diff", result.stdout, result.stderr, result.exitCode);
  }
};

const gitLogTool: ToolSpec = {
  name: "git_log",
  description:
    "Return a compact git log for the workspace repository, with optional author filtering, date ranges, path filtering, and graph view.",
  jsonSchema: {
    type: "object",
    properties: {
      maxCount: {
        type: "integer",
        description: "Maximum number of commits to show. Defaults to 10."
      },
      author: {
        type: "string",
        description: "Filter commits by author name or email (partial match)."
      },
      since: {
        type: "string",
        description: "Show commits more recent than this date (e.g. '2 weeks ago', '2024-01-01')."
      },
      until: {
        type: "string",
        description: "Show commits older than this date."
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Restrict log to commits affecting these paths."
      },
      graph: {
        type: "boolean",
        description: "Show ASCII graph of branch/merge history. Defaults to false."
      },
      ref: {
        type: "string",
        description: "Branch, tag, or ref to log. Defaults to HEAD."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const maxCount =
      typeof args.maxCount === "number" && Number.isInteger(args.maxCount) ? args.maxCount : 10;
    const graph = args.graph === true;
    const ref = typeof args.ref === "string" && args.ref.length > 0 ? args.ref : undefined;
    const paths =
      Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];

    const command = ["log", `--max-count=${maxCount}`, "--oneline", "--decorate"];
    if (graph) command.push("--graph");
    if (typeof args.author === "string" && args.author.length > 0) command.push(`--author=${args.author}`);
    if (typeof args.since === "string" && args.since.length > 0) command.push(`--since=${args.since}`);
    if (typeof args.until === "string" && args.until.length > 0) command.push(`--until=${args.until}`);
    if (ref) command.push(ref);
    if (paths.length > 0) command.push("--", ...paths);

    const result = await runExecFile("git", command, { cwd: context.workspaceRoot });
    return formatGitResult("git log", result.stdout, result.stderr, result.exitCode);
  }
};

const gitBlameTool: ToolSpec = {
  name: "git_blame",
  description: "Show what commit and author last modified each line of a file.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Required. Path to the file to blame, relative to workspace root."
      },
      startLine: {
        type: "integer",
        description: "Optional start line for a partial blame range."
      },
      endLine: {
        type: "integer",
        description: "Optional end line for a partial blame range."
      },
      rev: {
        type: "string",
        description: "Optional revision to blame at (defaults to HEAD)."
      }
    },
    required: ["path"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    if (typeof args.path !== "string" || args.path.length === 0) {
      return { summary: "git blame failed", content: "Missing required argument: path", isError: true };
    }

    const command = ["blame", "--porcelain"];
    if (typeof args.rev === "string" && args.rev.length > 0) command.push(args.rev);

    const hasRange =
      typeof args.startLine === "number" &&
      Number.isInteger(args.startLine) &&
      typeof args.endLine === "number" &&
      Number.isInteger(args.endLine);
    if (hasRange) command.push(`-L${args.startLine},${args.endLine}`);

    command.push("--", args.path);

    const result = await runExecFile("git", command, { cwd: context.workspaceRoot });
    return formatGitResult("git blame", result.stdout, result.stderr, result.exitCode);
  }
};

const gitShowTool: ToolSpec = {
  name: "git_show",
  description: "Show the contents and metadata of a specific git commit, tag, or tree object.",
  jsonSchema: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "Required. Commit SHA, tag, or ref to show."
      },
      stat: {
        type: "boolean",
        description: "Show a diffstat instead of full patch. Defaults to false."
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional file paths to restrict the shown diff to."
      }
    },
    required: ["ref"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    if (typeof args.ref !== "string" || args.ref.length === 0) {
      return { summary: "git show failed", content: "Missing required argument: ref", isError: true };
    }

    const command = ["show", "--no-ext-diff"];
    if (args.stat === true) command.push("--stat");
    command.push(args.ref);

    const paths =
      Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
    if (paths.length > 0) command.push("--", ...paths);

    const result = await runExecFile("git", command, { cwd: context.workspaceRoot });
    return formatGitResult("git show", result.stdout, result.stderr, result.exitCode);
  }
};

const gitBranchTool: ToolSpec = {
  name: "git_branch",
  description: "List local and/or remote branches, with optional verbose tracking info.",
  jsonSchema: {
    type: "object",
    properties: {
      all: {
        type: "boolean",
        description: "Show both local and remote branches. Defaults to false (local only)."
      },
      remotes: {
        type: "boolean",
        description: "Show only remote-tracking branches. Defaults to false."
      },
      verbose: {
        type: "boolean",
        description: "Show SHA and upstream tracking info for each branch. Defaults to false."
      },
      contains: {
        type: "string",
        description: "Only list branches that contain this commit SHA or ref."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const command = ["branch"];
    if (args.all === true) command.push("--all");
    else if (args.remotes === true) command.push("--remotes");
    if (args.verbose === true) command.push("--verbose", "--verbose"); // double -v shows upstream
    if (typeof args.contains === "string" && args.contains.length > 0)
      command.push("--contains", args.contains);

    const result = await runExecFile("git", command, { cwd: context.workspaceRoot });
    return formatGitResult("git branch", result.stdout, result.stderr, result.exitCode);
  }
};

const gitStashTool: ToolSpec = {
  name: "git_stash",
  description: "List stash entries or show the contents of a specific stash.",
  jsonSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "show"],
        description: "Action to perform: 'list' to enumerate stashes, 'show' to inspect one. Defaults to 'list'."
      },
      stashRef: {
        type: "string",
        description: "Stash ref to show (e.g. 'stash@{0}'). Required when action is 'show'."
      },
      stat: {
        type: "boolean",
        description: "When showing a stash, display a diffstat instead of full patch. Defaults to false."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const action = args.action === "show" ? "show" : "list";

    if (action === "list") {
      const result = await runExecFile("git", ["stash", "list"], { cwd: context.workspaceRoot });
      return formatGitResult("git stash list", result.stdout, result.stderr, result.exitCode);
    }

    const stashRef =
      typeof args.stashRef === "string" && args.stashRef.length > 0 ? args.stashRef : "stash@{0}";
    const command = ["stash", "show", "--no-ext-diff"];
    if (args.stat !== true) command.push("-p"); // full patch by default
    command.push(stashRef);

    const result = await runExecFile("git", command, { cwd: context.workspaceRoot });
    return formatGitResult(`git stash show ${stashRef}`, result.stdout, result.stderr, result.exitCode);
  }
};

function formatGitResult(summaryLabel: string, stdout: string, stderr: string, exitCode: number | null) {
  const content = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    summary: exitCode === 0 ? summaryLabel : `${summaryLabel} failed`,
    content: content || "(no output)",
    isError: exitCode !== 0
  };
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}
