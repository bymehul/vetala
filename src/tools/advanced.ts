import { runShellCommand } from "../process-utils.js";
import { searchRepo } from "./repo-search.js";
import type { ToolSpec } from "../types.js";

export function createAdvancedTools(): ToolSpec[] {
  return [semanticSearchTool, astReplaceTool, updateStateTool, taskCompletedTool];
}

const updateStateTool: ToolSpec = {
  name: "update_task_state",
  description: "Update the internal tracking state of your current task. Use this to remember what you have tried, what succeeded, and what failed. You can also define or update your own dynamic sub-tasks here to override the default plan.",
  jsonSchema: {
    type: "object",
    properties: {
      current_goal: { type: "string" },
      sub_tasks: { 
        type: "array", 
        items: { 
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] }
          },
          required: ["id", "label", "status"]
        },
        description: "List of specific sub-tasks you have defined for this goal. Updates the UI plan."
      },
      tried: { type: "array", items: { type: "string" } },
      succeeded: { type: "array", items: { type: "string" } },
      failed: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } }
    },
    required: ["current_goal", "tried", "succeeded", "failed", "next_steps"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    // Note: The actual UI plan update is handled by the agent loop observing this tool's arguments
    return {
      summary: "State tracking updated",
      content: `State successfully saved. Current Goal: ${args.current_goal}. Sub-tasks: ${Array.isArray(args.sub_tasks) ? args.sub_tasks.length : 0}.`,
      isError: false
    };
  }
};

const taskCompletedTool: ToolSpec = {
  name: "task_completed",
  description: "Mark the current overall task as completed. You MUST call this tool when you are 100% confident that the user's original request is fully implemented and empirically verified.",
  jsonSchema: {
    type: "object",
    properties: {
      confidence_score: { 
        type: "number", 
        description: "Your confidence level from 0 to 100 that the task is complete and verified." 
      },
      summary: { 
        type: "string", 
        description: "A summary of what was accomplished and how it was verified." 
      },
      unresolved_issues: {
        type: "array",
        items: { type: "string" },
        description: "Any remaining issues or warnings that the user should know about."
      }
    },
    required: ["confidence_score", "summary", "unresolved_issues"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    if (typeof args.confidence_score === "number" && args.confidence_score < 95) {
      return {
        summary: "Task completion rejected",
        content: `Your confidence score is ${args.confidence_score}%. You must reach at least 95% confidence by performing deeper verification before declaring the task completed.`,
        isError: true
      };
    }
    return {
      summary: "Task marked as completed",
      content: `Task completed with ${args.confidence_score}% confidence.\nSummary: ${args.summary}\nUnresolved: ${Array.isArray(args.unresolved_issues) ? args.unresolved_issues.join(", ") : "None"}`,
      isError: false
    };
  }
};

const semanticSearchTool: ToolSpec = {
  name: "semantic_search",
  description: "Search the codebase using a combination of concepts and keywords. Extracts meaning by running multiple parallel keyword searches.",
  jsonSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The natural language query (e.g. 'where is the auth token validated?')."
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "List of 2-4 exact keywords to search for based on the query (e.g. ['jwt', 'validateToken', 'auth'])."
      }
    },
    required: ["query", "keywords"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const keywords = Array.isArray(args.keywords) ? args.keywords.filter(k => typeof k === "string") : [];

    if (keywords.length === 0) {
      return { summary: "No keywords provided", content: "Please provide keywords for semantic search.", isError: true };
    }

    const allMatches = new Map<string, string>();
    const files = new Set<string>();

    for (const keyword of keywords) {
      const matches = await searchRepo({
        query: keyword,
        target: ".",
        cwd: context.workspaceRoot,
        limit: 10,
        mode: "fixed",
        caseSensitive: false,
        context
      });

      for (const match of matches) {
        const key = `${match.filePath}:${match.lineNumber}`;
        if (!allMatches.has(key)) {
          allMatches.set(key, `${match.filePath}:${match.lineNumber}: ${match.lineText}`);
          files.add(match.filePath);
        }
      }
    }

    if (allMatches.size === 0) {
      return { summary: "No semantic matches found", content: "(no matches)", isError: false };
    }

    return {
      summary: `Found ${allMatches.size} semantic matches across ${files.size} files`,
      content: Array.from(allMatches.values()).join("\n"),
      isError: false,
      referencedFiles: Array.from(files)
    };
  }
};

const astReplaceTool: ToolSpec = {
  name: "ast_replace",
  description: "Perform structural Abstract Syntax Tree (AST) search and replace using ast-grep (sg).",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file or directory."
      },
      pattern: {
        type: "string",
        description: "AST-grep pattern to find (e.g. 'function $A($$$B) { $$$C }')."
      },
      replacement: {
        type: "string",
        description: "Replacement string using AST variables (e.g. 'function $A($$$B) { console.log(\"patched\"); $$$C }')."
      }
    },
    required: ["path", "pattern", "replacement"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureWritable(requiredString(args.path, "path"));
    const pattern = requiredString(args.pattern, "pattern");
    const replacement = requiredString(args.replacement, "replacement");

    const whichCmd = process.platform === "win32" ? "where sg" : "which sg";
    const checkSg = await runShellCommand(whichCmd, { cwd: context.workspaceRoot });
    if (checkSg.exitCode !== 0) {
      return {
        summary: "ast-grep (sg) not installed",
        content: "The ast-grep (sg) CLI tool is not installed on this system. Please fall back to using 'replace_in_file' or 'apply_patch'.",
        isError: true
      };
    }

    const approved = await context.approvals.requestApproval({
      kind: "run_shell",
      key: `ast_replace:${target}`,
      label: `Allow AST Replace?\nPattern: ${pattern}\nReplacement: ${replacement}`
    });

    if (!approved) {
      return { summary: "AST replace denied", content: "Approval denied.", isError: true };
    }

    // Run sg rewrite
    // Usage: sg run -p 'pattern' -r 'replacement' target
    const p = quoteArg(pattern);
    const r = quoteArg(replacement);
    const cmd = `sg run -p ${p} -r ${r} ${target}`;
    const result = await runShellCommand(cmd, { cwd: context.workspaceRoot });

    if (result.exitCode !== 0) {
      return {
        summary: "AST replace failed",
        content: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
        isError: true
      };
    }

    return {
      summary: `AST replaced in ${target}`,
      content: "Successfully applied AST rewrite.",
      isError: false,
      referencedFiles: [target]
    };
  }
};

function quoteArg(arg: string): string {
  if (process.platform === "win32") {
    // Windows cmd.exe uses double quotes. Escape inner double quotes with backslash.
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  // Unix shells use single quotes. Escape inner single quotes by ending the string, 
  // adding an escaped single quote, and restarting.
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
