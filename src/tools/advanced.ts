import { runShellCommand } from "../process-utils.js";
import { searchRepo } from "./repo-search.js";
import type { ToolSpec } from "../types.js";

export function createAdvancedTools(): ToolSpec[] {
  return [semanticSearchTool, astReplaceTool];
}

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
        caseSensitive: false
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

    const checkSg = await runShellCommand("which sg", { cwd: context.workspaceRoot });
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
    const cmd = `sg run -p '${pattern.replace(/'/g, "'\\''")}' -r '${replacement.replace(/'/g, "'\\''")}' ${target}`;
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
