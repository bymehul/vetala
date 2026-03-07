import path from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { runExecFile } from "../process-utils.js";
import type { ToolContext, ToolResult, ToolSpec } from "../types.js";

const MAX_READ_LINES = 400;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_SYMBOL_LIMIT = 3;
const DEFAULT_SYMBOL_CONTEXT = 20;

interface SearchMatch {
  filePath: string;
  lineNumber: number;
  lineText: string;
}

interface PatchChange {
  search: string;
  replace: string;
  all: boolean;
}

export function createFilesystemTools(): ToolSpec[] {
  return [
    listDirTool,
    searchRepoTool,
    searchFilesTool,
    readFileTool,
    readFileChunkTool,
    readSymbolTool,
    writeFileTool,
    applyPatchTool,
    replaceInFileTool
  ];
}

const listDirTool: ToolSpec = {
  name: "list_dir",
  description: "List files and directories for a path within the approved workspace roots.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list. Defaults to the current working directory."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureReadable(stringOrDefault(args.path, "."));
    const entries = await readdir(target, { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 200)
        .map(async (entry) => {
          const entryPath = path.join(target, entry.name);
          const entryStats = await stat(entryPath);
          const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
          return `${kind} ${entryStats.size.toString().padStart(8, " ")} ${entry.name}`;
        })
    );

    return {
      summary: `Listed ${rows.length} entries in ${target}`,
      content: rows.join("\n") || "(empty directory)",
      isError: false,
      referencedFiles: [target]
    };
  }
};

const searchRepoTool: ToolSpec = {
  name: "search_repo",
  description: "Search the repo for a fixed string and return file:line matches. Use this before reading or editing files.",
  jsonSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Fixed string to search for."
      },
      path: {
        type: "string",
        description: "Directory or file to search. Defaults to the current working directory."
      },
      limit: {
        type: "integer",
        description: "Maximum number of matches to return. Defaults to 20."
      }
    },
    required: ["query"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    return executeSearchTool(args, context);
  }
};

const searchFilesTool: ToolSpec = {
  name: "search_files",
  description: "Legacy alias for search_repo.",
  jsonSchema: searchRepoTool.jsonSchema,
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    return executeSearchTool(args, context);
  }
};

const readFileTool: ToolSpec = {
  name: "read_file",
  description: "Read a UTF-8 text file, optionally limiting the output to a line range.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read."
      },
      startLine: {
        type: "integer",
        description: "Optional 1-based starting line."
      },
      endLine: {
        type: "integer",
        description: "Optional 1-based ending line."
      }
    },
    required: ["path"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureReadable(requiredString(args.path, "path"));
    const fileContent = await readFile(target, "utf8");
    const lines = fileContent.split("\n");
    const startLine = integerOrDefault(args.startLine, 1);
    const endLine = integerOrDefault(args.endLine, Math.min(lines.length, startLine + MAX_READ_LINES - 1));

    return renderReadSlice(target, lines, startLine, endLine);
  }
};

const readFileChunkTool: ToolSpec = {
  name: "read_file_chunk",
  description: "Read only a specific line range from a UTF-8 text file.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read."
      },
      startLine: {
        type: "integer",
        description: "1-based starting line."
      },
      endLine: {
        type: "integer",
        description: "1-based ending line."
      }
    },
    required: ["path", "startLine", "endLine"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureReadable(requiredString(args.path, "path"));
    const startLine = requiredInteger(args.startLine, "startLine");
    const endLine = requiredInteger(args.endLine, "endLine");
    const fileContent = await readFile(target, "utf8");
    const lines = fileContent.split("\n");

    return renderReadSlice(target, lines, startLine, endLine);
  }
};

const readSymbolTool: ToolSpec = {
  name: "read_symbol",
  description: "Search for a symbol or definition string and read matching code chunks with surrounding context.",
  jsonSchema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Fixed string to search for, such as a function name or signature."
      },
      path: {
        type: "string",
        description: "Directory or file to search. Defaults to the current working directory."
      },
      limit: {
        type: "integer",
        description: "Maximum number of symbol matches to read. Defaults to 3."
      },
      contextLines: {
        type: "integer",
        description: "Number of surrounding lines to include before and after the match. Defaults to 20."
      }
    },
    required: ["symbol"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const symbol = requiredString(args.symbol, "symbol");
    const target = await context.paths.ensureReadable(stringOrDefault(args.path, "."));
    const limit = clampInteger(integerOrDefault(args.limit, DEFAULT_SYMBOL_LIMIT), 1, 8);
    const contextLines = clampInteger(integerOrDefault(args.contextLines, DEFAULT_SYMBOL_CONTEXT), 1, 80);
    const matches = await findTextMatches(symbol, target, limit, context);

    if (matches.length === 0) {
      return {
        summary: `No symbol matches for "${symbol}"`,
        content: "(no matches)",
        isError: false,
        referencedFiles: [target]
      };
    }

    const rendered = await Promise.all(matches.map(async (match) => {
      const fileContent = await readFile(match.filePath, "utf8");
      const lines = fileContent.split("\n");
      const startLine = Math.max(1, match.lineNumber - contextLines);
      const endLine = Math.min(lines.length, match.lineNumber + contextLines);
      return [
        `${match.filePath}:${match.lineNumber}`,
        renderNumberedLines(lines, startLine, endLine)
      ].join("\n");
    }));
    const files = unique(matches.map((match) => match.filePath));

    return {
      summary: `Read ${matches.length} symbol match${matches.length === 1 ? "" : "es"} for "${symbol}"`,
      content: rendered.join("\n\n"),
      isError: false,
      referencedFiles: files,
      readFiles: files
    };
  }
};

const writeFileTool: ToolSpec = {
  name: "write_file",
  description: "Write or create a UTF-8 file after approval. Existing files must be read first.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write."
      },
      content: {
        type: "string",
        description: "Full file contents to write."
      }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureWritable(requiredString(args.path, "path"));
    const guard = await denyUnreadEdit(target, context, "write to");

    if (guard) {
      return guard;
    }

    const approved = await context.approvals.requestApproval({
      kind: "write_file",
      key: `write_file:${target}`,
      label: `Allow writing file?\npath: ${target}`
    });

    if (!approved) {
      return denied(`Write denied for ${target}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, requiredString(args.content, "content"), "utf8");
    return {
      summary: `Wrote ${target}`,
      content: `File written successfully:\n${target}`,
      isError: false,
      referencedFiles: [target]
    };
  }
};

const applyPatchTool: ToolSpec = {
  name: "apply_patch",
  description: "Apply one or more search-and-replace patch hunks to an existing UTF-8 file after it has been read.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to patch."
      },
      changes: {
        type: "array",
        description: "Ordered patch hunks to apply.",
        items: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Text to find."
            },
            replace: {
              type: "string",
              description: "Replacement text."
            },
            all: {
              type: "boolean",
              description: "Replace every occurrence of search within the current file state."
            }
          },
          required: ["search", "replace"],
          additionalProperties: false
        }
      }
    },
    required: ["path", "changes"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureWritable(requiredString(args.path, "path"));
    const guard = await denyUnreadEdit(target, context, "patch");

    if (guard) {
      return guard;
    }

    const changes = requiredPatchChanges(args.changes);
    const approved = await context.approvals.requestApproval({
      kind: "replace_in_file",
      key: `replace_in_file:${target}`,
      label: `Allow patching file?\npath: ${target}\nchanges: ${changes.length}`
    });

    if (!approved) {
      return denied(`Patch denied for ${target}`);
    }

    return applyPatchChanges(target, changes);
  }
};

const replaceInFileTool: ToolSpec = {
  name: "replace_in_file",
  description: "Replace text inside an existing UTF-8 file after approval. The file must be read first.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit."
      },
      search: {
        type: "string",
        description: "Text to find."
      },
      replace: {
        type: "string",
        description: "Replacement text."
      },
      all: {
        type: "boolean",
        description: "Replace every occurrence. Defaults to false."
      }
    },
    required: ["path", "search", "replace"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureWritable(requiredString(args.path, "path"));
    const guard = await denyUnreadEdit(target, context, "edit");

    if (guard) {
      return guard;
    }

    const approved = await context.approvals.requestApproval({
      kind: "replace_in_file",
      key: `replace_in_file:${target}`,
      label: `Allow editing file?\npath: ${target}`
    });

    if (!approved) {
      return denied(`Replace denied for ${target}`);
    }

    return applyPatchChanges(target, [
      {
        search: requiredString(args.search, "search"),
        replace: requiredString(args.replace, "replace"),
        all: booleanOrDefault(args.all, false)
      }
    ]);
  }
};

async function executeSearchTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const query = requiredString(args.query, "query");
  const target = await context.paths.ensureReadable(stringOrDefault(args.path, "."));
  const limit = clampInteger(integerOrDefault(args.limit, DEFAULT_SEARCH_LIMIT), 1, 200);
  const matches = await findTextMatches(query, target, limit, context);

  return {
    summary: matches.length > 0 ? `Found matches for "${query}"` : `No matches for "${query}"`,
    content: matches.length > 0
      ? matches.map((match) => `${match.filePath}:${match.lineNumber}:${match.lineText}`).join("\n")
      : "(no matches)",
    isError: false,
    referencedFiles: [target]
  };
}

function renderReadSlice(target: string, lines: string[], startLine: number, endLine: number): ToolResult {
  if (startLine < 1 || endLine < startLine) {
    return {
      summary: `Invalid line range for ${target}`,
      content: `Invalid line range: ${startLine}-${endLine}`,
      isError: true,
      referencedFiles: [target]
    };
  }

  const boundedEndLine = Math.min(lines.length, Math.min(endLine, startLine + MAX_READ_LINES - 1));

  return {
    summary: `Read ${target} lines ${startLine}-${boundedEndLine}`,
    content: renderNumberedLines(lines, startLine, boundedEndLine),
    isError: false,
    referencedFiles: [target],
    readFiles: [target]
  };
}

function renderNumberedLines(lines: string[], startLine: number, endLine: number): string {
  const slice = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine));
  return slice.map((line, index) => `${startLine + index}`.padStart(4, " ") + ` ${line}`).join("\n");
}

async function denyUnreadEdit(target: string, context: ToolContext, action: string): Promise<ToolResult | null> {
  if (!await existsPath(target)) {
    return null;
  }

  if (context.reads.hasRead(target)) {
    return null;
  }

  return denied(
    `Refusing to ${action} ${target} before reading it. Use search_repo to find it, then read_file, read_file_chunk, or read_symbol first.`
  );
}

async function applyPatchChanges(target: string, changes: PatchChange[]): Promise<ToolResult> {
  const original = await readFile(target, "utf8");
  let updated = original;
  let replacements = 0;

  for (const change of changes) {
    const occurrenceCount = countOccurrences(updated, change.search);

    if (occurrenceCount === 0) {
      return {
        summary: `Patch text not found in ${target}`,
        content: `No occurrences of the requested text were found in ${target}.`,
        isError: true,
        referencedFiles: [target]
      };
    }

    replacements += change.all ? occurrenceCount : 1;
    updated = change.all
      ? updated.split(change.search).join(change.replace)
      : updated.replace(change.search, change.replace);
  }

  await writeFile(target, updated, "utf8");
  return {
    summary: `Patched ${target} (${changes.length} change${changes.length === 1 ? "" : "s"}, ${replacements} replacement${replacements === 1 ? "" : "s"})`,
    content: `Applied ${changes.length} patch change${changes.length === 1 ? "" : "s"} in ${target}.`,
    isError: false,
    referencedFiles: [target]
  };
}

async function findTextMatches(
  query: string,
  target: string,
  limit: number,
  context: ToolContext
): Promise<SearchMatch[]> {
  try {
    const result = await runExecFile(
      "rg",
      [
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        String(limit),
        query,
        target
      ],
      { cwd: context.cwd }
    );

    return parseSearchMatches(`${result.stdout}${result.stderr}`, limit);
  } catch (error) {
    if (!isMissingBinary(error)) {
      throw error;
    }

    return fallbackSearch(query, target, limit);
  }
}

function parseSearchMatches(output: string, limit: number): SearchMatch[] {
  const matches: SearchMatch[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^(.*?):(\d+):(.*)$/);

    if (!match) {
      continue;
    }

    matches.push({
      filePath: match[1] ?? "",
      lineNumber: Number(match[2]),
      lineText: match[3] ?? ""
    });

    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

function requiredPatchChanges(value: unknown): PatchChange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Missing patch changes.");
  }

  return value.map((entry, index) => {
    const object = expectObject(entry);
    return {
      search: requiredString(object.search, `changes[${index}].search`),
      replace: requiredStringOrEmpty(object.replace, `changes[${index}].replace`),
      all: booleanOrDefault(object.all, false)
    };
  });
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

function requiredStringOrEmpty(value: unknown, key: string): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Missing string argument: ${key}`);
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function requiredInteger(value: unknown, key: string): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  throw new Error(`Missing integer argument: ${key}`);
}

function integerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function denied(message: string): ToolResult {
  return {
    summary: message,
    content: message,
    isError: true
  };
}

function isMissingBinary(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }

  return content.split(search).length - 1;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function fallbackSearch(query: string, target: string, limit: number): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const stats = await stat(target);

  if (stats.isFile()) {
    await searchFile(query, target, matches, limit);
    return matches;
  }

  const queue = [target];

  while (queue.length > 0 && matches.length < limit) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= limit) {
        break;
      }

      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (entry.isFile()) {
        await searchFile(query, entryPath, matches, limit);
      }
    }
  }

  return matches;
}

async function searchFile(query: string, filePath: string, matches: SearchMatch[], limit: number): Promise<void> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");

    for (const [index, line] of lines.entries()) {
      if (line.includes(query)) {
        matches.push({
          filePath,
          lineNumber: index + 1,
          lineText: line
        });
      }

      if (matches.length >= limit) {
        return;
      }
    }
  } catch {
    // Skip unreadable or binary files in the fallback path.
  }
}
