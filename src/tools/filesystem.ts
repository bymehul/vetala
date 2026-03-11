import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { buildDiffPreview, lcsDiff } from "../edits/diff.js";
import type { ToolContext, ToolResult, ToolSpec } from "../types.js";
import { searchRepo, searchRepoSymbol } from "./repo-search.js";

const MAX_READ_LINES = 400;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_SYMBOL_LIMIT = 3;
const DEFAULT_SYMBOL_CONTEXT = 20;

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
    appendToFileTool,
    applyPatchTool,
    replaceInFileTool,
    moveFileTool,
    deleteFileTool
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
      },
      mode: {
        type: "string",
        description: "Search mode: `fixed` for exact text or `regex` for a regular expression. Defaults to `fixed`."
      },
      caseSensitive: {
        type: "boolean",
        description: "If true, match case exactly. Defaults to false."
      },
      globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional glob filters to limit the search, for example `src/**/*.ts`."
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
      },
      globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional glob filters to limit the symbol search."
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
    const matches = await searchRepoSymbol({
      symbol,
      target,
      cwd: context.cwd,
      limit,
      globs: stringArray(args.globs)
    });

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
  description: "Write or create a UTF-8 file. Existing files MUST be read first. Provide the complete file content. DO NOT USE PLACEHOLDERS like '...rest of code...'.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write."
      },
      content: {
        type: "string",
        description: "Full, complete file contents to write. Do not truncate."
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
      key: `edit_file:${target}`,
      label: [
        "Allow writing file?",
        `path: ${target}`,
        "",
        buildDiffPreview(target, await readExistingText(target), requiredString(args.content, "content"))
      ].join("\n")
    });

    if (!approved) {
      return denied(`Write denied for ${target}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    const nextContent = requiredString(args.content, "content");
    const previousContent = await readExistingText(target);
    await writeFile(target, nextContent, "utf8");
    await context.edits.recordEdit({
      path: target,
      beforeContent: previousContent,
      afterContent: nextContent,
      summary: "write_file"
    });
    return successWithDiff(target, previousContent, nextContent, `Wrote ${target}`);
  }
};

const appendToFileTool: ToolSpec = {
  name: "append_to_file",
  description: "Append content to the end of a UTF-8 file. Useful for adding new code without rewriting the whole file.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to append to."
      },
      content: {
        type: "string",
        description: "Content to append to the file."
      }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureWritable(requiredString(args.path, "path"));
    const guard = await denyUnreadEdit(target, context, "append to");

    if (guard) {
      return guard;
    }

    const newContent = requiredString(args.content, "content");
    const previousContent = await readExistingText(target) || "";
    const nextContent = previousContent + newContent;

    const approved = await context.approvals.requestApproval({
      kind: "write_file",
      key: `edit_file:${target}`,
      label: [
        "Allow appending to file?",
        `path: ${target}`,
        "",
        buildDiffPreview(target, previousContent, nextContent)
      ].join("\n")
    });

    if (!approved) {
      return denied(`Append denied for ${target}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, newContent, "utf8");
    await context.edits.recordEdit({
      path: target,
      beforeContent: previousContent,
      afterContent: nextContent,
      summary: "append_to_file"
    });
    return successWithDiff(target, previousContent, nextContent, `Appended to ${target}`);
  }
};

const applyPatchTool: ToolSpec = {
  name: "apply_patch",
  description: "Apply search-and-replace patch hunks to an existing file. The file MUST be read first. Your 'search' text must EXACTLY MATCH the target file, including all whitespace and indentation.",
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
              description: "EXACT text to find, including leading spaces. Provide enough context lines to ensure uniqueness."
            },
            replace: {
              type: "string",
              description: "Replacement text to insert."
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
    const original = await readFile(target, "utf8");
    let applied;

    try {
      applied = applyChangesToContent(target, original, changes);
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error));
    }

    const approved = await context.approvals.requestApproval({
      kind: "replace_in_file",
      key: `edit_file:${target}`,
      label: [
        "Allow patching file?",
        `path: ${target}`,
        `changes: ${changes.length}`,
        "",
        buildDiffPreview(target, original, applied.updated)
      ].join("\n")
    });

    if (!approved) {
      return denied(`Patch denied for ${target}`);
    }

    return writePatchedFile(target, original, applied.updated, `Patched ${target}`, context, changes.length, applied.replacements);
  }
};

const replaceInFileTool: ToolSpec = {
  name: "replace_in_file",
  description: "Replace text inside an existing file. The file MUST be read first. The 'search' string must EXACTLY match the current file contents, including indentation.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit."
      },
      search: {
        type: "string",
        description: "EXACT text to find. Provide enough lines of context to ensure a unique match."
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

    const original = await readFile(target, "utf8");
    let applied;

    try {
      applied = applyChangesToContent(target, original, [
        {
          search: requiredString(args.search, "search"),
          replace: requiredStringOrEmpty(args.replace, "replace"),
          all: booleanOrDefault(args.all, false)
        }
      ]);
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error));
    }

    const approved = await context.approvals.requestApproval({
      kind: "replace_in_file",
      key: `edit_file:${target}`,
      label: [
        "Allow editing file?",
        `path: ${target}`,
        "",
        buildDiffPreview(target, original, applied.updated)
      ].join("\n")
    });

    if (!approved) {
      return denied(`Replace denied for ${target}`);
    }

    return writePatchedFile(target, original, applied.updated, `Edited ${target}`, context, 1, applied.replacements);
  }
};

const moveFileTool: ToolSpec = {
  name: "move_file",
  description: "Move or rename a file or directory.",
  jsonSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Path to the file or directory to move."
      },
      destination: {
        type: "string",
        description: "Destination path."
      }
    },
    required: ["source", "destination"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const source = await context.paths.ensureReadable(requiredString(args.source, "source"));
    const destination = await context.paths.ensureWritable(requiredString(args.destination, "destination"));

    const approved = await context.approvals.requestApproval({
      kind: "run_shell",
      key: `move_file:${source}:${destination}`,
      label: `Allow moving file?\nFrom: ${source}\nTo: ${destination}`
    });

    if (!approved) {
      return denied(`Move denied for ${source} to ${destination}`);
    }

    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      return {
        summary: `Moved ${source} to ${destination}`,
        content: `Successfully moved ${source} to ${destination}`,
        isError: false,
        referencedFiles: [source, destination]
      };
    } catch (error) {
      return {
        summary: `Failed to move ${source}`,
        content: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }
  }
};

const deleteFileTool: ToolSpec = {
  name: "delete_file",
  description: "Delete a file.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to delete."
      }
    },
    required: ["path"],
    additionalProperties: false
  },
  readOnly: false,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureWritable(requiredString(args.path, "path"));

    const approved = await context.approvals.requestApproval({
      kind: "run_shell",
      key: `delete_file:${target}`,
      label: `Allow deleting file?\nPath: ${target}`
    });

    if (!approved) {
      return denied(`Delete denied for ${target}`);
    }

    try {
      await unlink(target);
      return {
        summary: `Deleted ${target}`,
        content: `Successfully deleted ${target}`,
        isError: false,
        referencedFiles: [target]
      };
    } catch (error) {
      return {
        summary: `Failed to delete ${target}`,
        content: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }
  }
};

async function executeSearchTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const query = requiredString(args.query, "query");
  const target = await context.paths.ensureReadable(stringOrDefault(args.path, "."));
  const limit = clampInteger(integerOrDefault(args.limit, DEFAULT_SEARCH_LIMIT), 1, 200);
  const matches = await searchRepo({
    query,
    target,
    cwd: context.cwd,
    limit,
    mode: args.mode === "regex" ? "regex" : "fixed",
    caseSensitive: args.caseSensitive === true,
    globs: stringArray(args.globs)
  });

  return {
    summary: matches.length > 0 ? `Found ${matches.length} matches for "${query}"` : `No matches for "${query}"`,
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

async function readExistingText(target: string): Promise<string | null> {
  if (!await existsPath(target)) {
    return null;
  }

  return readFile(target, "utf8");
}

function applyChangesToContent(target: string, original: string, changes: PatchChange[]): { updated: string; replacements: number } {
  let updated = original;
  let replacements = 0;

  for (const change of changes) {
    const occurrenceCount = countOccurrences(updated, change.search);

    if (occurrenceCount === 0) {
      throw new Error(`No occurrences of the requested text were found in ${target}.`);
    }

    replacements += change.all ? occurrenceCount : 1;
    updated = change.all
      ? updated.split(change.search).join(change.replace)
      : updated.replace(change.search, change.replace);
  }

  return { updated, replacements };
}

async function writePatchedFile(
  target: string,
  original: string,
  updated: string,
  summary: string,
  context: ToolContext,
  changeCount: number,
  replacements: number
): Promise<ToolResult> {
  await writeFile(target, updated, "utf8");
  await context.edits.recordEdit({
    path: target,
    beforeContent: original,
    afterContent: updated,
    summary
  });

  const beforeLines = original.split("\n");
  const afterLines = updated.split("\n");
  const stats = summarizeDiffOps(beforeLines, afterLines);

  return {
    summary: `${summary} (${changeCount} change${changeCount === 1 ? "" : "s"}, ${replacements} replacement${replacements === 1 ? "" : "s"})`,
    content: [
      `Applied ${changeCount} change${changeCount === 1 ? "" : "s"} in ${target}.`,
      "",
      `changes: +${stats.added} -${stats.removed}`
    ].join("\n"),
    isError: false,
    referencedFiles: [target]
  };
}

function successWithDiff(target: string, beforeContent: string | null, afterContent: string, summary: string): ToolResult {
  const beforeLines = beforeContent ? beforeContent.split("\n") : [];
  const afterLines = afterContent.split("\n");
  const stats = beforeLines.length === 0 ? { added: afterLines.length, removed: 0 } : summarizeDiffOps(beforeLines, afterLines);

  return {
    summary,
    content: [
      `File written successfully:`,
      target,
      "",
      `changes: +${stats.added} -${stats.removed}`
    ].join("\n"),
    isError: false,
    referencedFiles: [target]
  };
}

function summarizeDiffOps(beforeLines: string[], afterLines: string[]): { added: number; removed: number } {
  const ops = lcsDiff(beforeLines, afterLines);
  let added = 0;
  let removed = 0;

  for (const op of ops) {
    if (op.type === "add") {
      added += 1;
    } else if (op.type === "remove") {
      removed += 1;
    }
  }

  return { added, removed };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}
