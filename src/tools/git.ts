import type { ToolContext, ToolSpec } from "../types.js";
import { runExecFile } from "../process-utils.js";

const DEFAULT_GIT_CONTEXT_LINES = 3;
const MAX_UNTRACKED_FILES = 100;

export function createGitTools(): ToolSpec[] {
  return [gitReviewTool, gitStatusTool, gitDiffTool, gitLogTool, gitBlameTool, gitShowTool, gitBranchTool, gitStashTool];
}

export interface GitReviewOptions {
  cwd: string;
  target?: "worktree" | "base_branch" | "commit";
  baseBranch?: string;
  ref?: string;
  stat?: boolean;
  paths?: string[];
  contextLines?: number;
  includeUntracked?: boolean;
}

export interface GitReviewReport {
  summary: string;
  content: string;
  isError: boolean;
  mergeBaseSha?: string;
  baseRef?: string;
}

const gitReviewTool: ToolSpec = {
  name: "git_review",
  description:
    "Prepare a review-ready git change report. Supports full worktree review, merge-base diffs against a base branch, and commit inspection.",
  jsonSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["worktree", "base_branch", "commit"],
        description: "What to inspect. Defaults to 'worktree'."
      },
      baseBranch: {
        type: "string",
        description: "Base branch for merge-base review, for example 'main'. Required when target is 'base_branch'."
      },
      ref: {
        type: "string",
        description: "Commit or ref to inspect when target is 'commit'."
      },
      stat: {
        type: "boolean",
        description: "If true, show diffstat summaries instead of full patches. Defaults to false."
      },
      includeUntracked: {
        type: "boolean",
        description: "Include untracked files in the report. Defaults to true."
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of file paths to restrict the report to."
      },
      contextLines: {
        type: "integer",
        description: "Context lines around each change when rendering patches. Defaults to 3."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const baseBranch = optionalNonEmptyString(args.baseBranch);
    const ref = optionalNonEmptyString(args.ref);
    const report = await buildGitReviewReport({
      cwd: context.workspaceRoot,
      target: parseReviewTarget(args.target),
      stat: args.stat === true,
      includeUntracked: args.includeUntracked !== false,
      paths: stringArray(args.paths),
      contextLines: parseContextLines(args.contextLines),
      ...(baseBranch ? { baseBranch } : {}),
      ...(ref ? { ref } : {})
    });
    return {
      summary: report.summary,
      content: report.content,
      isError: report.isError
    };
  }
};

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
    const result = await runGit(
      context.workspaceRoot,
      ["status", ...format, `--untracked-files=${showUntracked}`]
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
      baseBranch: {
        type: "string",
        description: "Optional base branch to diff against via merge-base, for example 'main'."
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
    const baseBranch = optionalNonEmptyString(args.baseBranch);
    const staged = args.staged === true;
    const stat = args.stat === true;
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
    const contextLines = parseContextLines(args.contextLines);

    const command = ["diff", "--no-ext-diff", `-U${contextLines}`];
    if (staged) command.push("--cached");
    if (stat) command.push("--stat");
    if (baseBranch) {
      const base = await resolveGitBaseBranch(context.workspaceRoot, baseBranch);
      if (!base.mergeBaseSha) {
        return {
          summary: "git diff failed",
          content: `Unable to resolve a merge base against ${baseBranch}.`,
          isError: true
        };
      }
      command.push(base.mergeBaseSha);
    } else if (ref) {
      command.push(ref);
    }
    if (paths.length > 0) command.push("--", ...paths);

    const result = await runGit(context.workspaceRoot, command);
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

    const result = await runGit(context.workspaceRoot, command);
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

    const result = await runGit(context.workspaceRoot, command);
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

    const result = await runGit(context.workspaceRoot, command);
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

    const result = await runGit(context.workspaceRoot, command);
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
      const result = await runGit(context.workspaceRoot, ["stash", "list"]);
      return formatGitResult("git stash list", result.stdout, result.stderr, result.exitCode);
    }

    const stashRef =
      typeof args.stashRef === "string" && args.stashRef.length > 0 ? args.stashRef : "stash@{0}";
    const command = ["stash", "show", "--no-ext-diff"];
    if (args.stat !== true) command.push("-p"); // full patch by default
    command.push(stashRef);

    const result = await runGit(context.workspaceRoot, command);
    return formatGitResult(`git stash show ${stashRef}`, result.stdout, result.stderr, result.exitCode);
  }
};

export async function buildGitReviewReport(options: GitReviewOptions): Promise<GitReviewReport> {
  const target = options.target ?? "worktree";
  const stat = options.stat === true;
  const includeUntracked = options.includeUntracked !== false;
  const contextLines = options.contextLines ?? DEFAULT_GIT_CONTEXT_LINES;
  const paths = options.paths?.filter((path) => path.length > 0) ?? [];

  switch (target) {
    case "base_branch":
      return buildBaseBranchReview(options.cwd, {
        stat,
        includeUntracked,
        paths,
        contextLines,
        ...(options.baseBranch ? { baseBranch: options.baseBranch } : {})
      });
    case "commit":
      return buildCommitReview(options.cwd, {
        stat,
        paths,
        ...(options.ref ? { ref: options.ref } : {})
      });
    case "worktree":
    default:
      return buildWorktreeReview(options.cwd, {
        stat,
        includeUntracked,
        paths,
        contextLines
      });
  }
}

export async function resolveGitBaseBranch(
  cwd: string,
  baseBranch: string
): Promise<{ requestedBranch: string; baseRef: string; mergeBaseSha: string | null }> {
  const requestedBranch = baseBranch.trim();
  const upstreamProbe = await runGit(cwd, ["rev-parse", "--verify", "--symbolic-full-name", `${requestedBranch}@{upstream}`]);
  const baseRef = upstreamProbe.exitCode === 0 && upstreamProbe.stdout.trim() ? upstreamProbe.stdout.trim() : requestedBranch;
  const mergeBase = await runGit(cwd, ["merge-base", "HEAD", baseRef]);
  return {
    requestedBranch,
    baseRef,
    mergeBaseSha: mergeBase.exitCode === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : null
  };
}

async function buildWorktreeReview(
  cwd: string,
  options: { stat: boolean; includeUntracked: boolean; paths: string[]; contextLines: number }
): Promise<GitReviewReport> {
  const status = await runGit(cwd, ["status", "--short", "--branch", "--untracked-files=all"]);
  if (status.exitCode !== 0) {
    return formatGitResult("git review", status.stdout, status.stderr, status.exitCode);
  }

  const stagedCommand = ["diff", "--cached", "--no-ext-diff", `-U${options.contextLines}`];
  const unstagedCommand = ["diff", "--no-ext-diff", `-U${options.contextLines}`];
  if (options.stat) {
    stagedCommand.push("--stat");
    unstagedCommand.push("--stat");
  }
  if (options.paths.length > 0) {
    stagedCommand.push("--", ...options.paths);
    unstagedCommand.push("--", ...options.paths);
  }

  const [staged, unstaged, untracked] = await Promise.all([
    runGit(cwd, stagedCommand),
    runGit(cwd, unstagedCommand),
    options.includeUntracked ? listUntrackedFiles(cwd, options.paths) : Promise.resolve([])
  ]);

  const content = joinSections([
    {
      title: "status",
      body: status.stdout.trim() || "(clean)"
    },
    staged.stdout.trim()
      ? {
          title: options.stat ? "staged diffstat" : "staged changes",
          body: staged.stdout.trim()
        }
      : null,
    unstaged.stdout.trim()
      ? {
          title: options.stat ? "unstaged diffstat" : "unstaged changes",
          body: unstaged.stdout.trim()
        }
      : null,
    untracked.length > 0
      ? {
          title: "untracked files",
          body: renderUntrackedFiles(untracked)
        }
      : null
  ]);

  return {
    summary: "git review (worktree)",
    content: content || "(no changes)",
    isError: staged.exitCode !== 0 || unstaged.exitCode !== 0
  };
}

async function buildBaseBranchReview(
  cwd: string,
  options: { baseBranch?: string; stat: boolean; includeUntracked: boolean; paths: string[]; contextLines: number }
): Promise<GitReviewReport> {
  if (!options.baseBranch) {
    return {
      summary: "git review failed",
      content: "Missing required argument: baseBranch",
      isError: true
    };
  }

  const base = await resolveGitBaseBranch(cwd, options.baseBranch);
  if (!base.mergeBaseSha) {
    return {
      summary: "git review failed",
      content: `Unable to resolve a merge base against ${options.baseBranch}.`,
      isError: true
    };
  }

  const command = ["diff", "--no-ext-diff", `-U${options.contextLines}`];
  if (options.stat) {
    command.push("--stat");
  }
  command.push(base.mergeBaseSha);
  if (options.paths.length > 0) {
    command.push("--", ...options.paths);
  }

  const [diff, untracked] = await Promise.all([
    runGit(cwd, command),
    options.includeUntracked ? listUntrackedFiles(cwd, options.paths) : Promise.resolve([])
  ]);

  const content = joinSections([
    {
      title: "base branch",
      body: `${base.requestedBranch}\nresolved ref: ${base.baseRef}\nmerge base: ${base.mergeBaseSha}`
    },
    {
      title: options.stat ? "diffstat against merge base" : "diff against merge base",
      body: diff.stdout.trim() || "(no changes)"
    },
    untracked.length > 0
      ? {
          title: "untracked files",
          body: renderUntrackedFiles(untracked)
        }
      : null
  ]);

  return {
    summary: `git review against ${base.requestedBranch}`,
    content,
    isError: diff.exitCode !== 0,
    mergeBaseSha: base.mergeBaseSha,
    baseRef: base.baseRef
  };
}

async function buildCommitReview(
  cwd: string,
  options: { ref?: string; stat: boolean; paths: string[] }
): Promise<GitReviewReport> {
  if (!options.ref) {
    return {
      summary: "git review failed",
      content: "Missing required argument: ref",
      isError: true
    };
  }

  const command = ["show", "--no-ext-diff"];
  if (options.stat) {
    command.push("--stat");
  }
  command.push(options.ref);
  if (options.paths.length > 0) {
    command.push("--", ...options.paths);
  }

  const result = await runGit(cwd, command);
  return {
    summary: `git review commit ${options.ref}`,
    content: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)",
    isError: result.exitCode !== 0
  };
}

function formatGitResult(summaryLabel: string, stdout: string, stderr: string, exitCode: number | null) {
  const content = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    summary: exitCode === 0 ? summaryLabel : `${summaryLabel} failed`,
    content: content || "(no output)",
    isError: exitCode !== 0
  };
}

async function runGit(cwd: string, args: string[]) {
  return runExecFile("git", ["-c", "color.ui=never", ...args], {
    cwd,
    noPty: true
  });
}

async function listUntrackedFiles(cwd: string, paths: string[]): Promise<string[]> {
  const command = ["ls-files", "--others", "--exclude-standard"];
  if (paths.length > 0) {
    command.push("--", ...paths);
  }
  const result = await runGit(cwd, command);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES);
}

function renderUntrackedFiles(paths: string[]): string {
  if (paths.length === 0) {
    return "(none)";
  }
  const lines = paths.map((path) => `?? ${path}`);
  if (paths.length >= MAX_UNTRACKED_FILES) {
    lines.push(`... (${MAX_UNTRACKED_FILES}+ files shown)`);
  }
  return lines.join("\n");
}

function joinSections(sections: Array<{ title: string; body: string } | null>): string {
  return sections
    .filter((section): section is { title: string; body: string } => section !== null)
    .map((section) => `${section.title}\n${section.body}`)
    .join("\n\n");
}

function parseReviewTarget(value: unknown): "worktree" | "base_branch" | "commit" {
  return value === "base_branch" || value === "commit" ? value : "worktree";
}

function parseContextLines(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_GIT_CONTEXT_LINES;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}
