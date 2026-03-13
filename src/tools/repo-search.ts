import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { runExecFile } from "../process-utils.js";
import type { ToolContext } from "../types.js";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage"
]);

export interface RepoSearchMatch {
  filePath: string;
  lineNumber: number;
  lineText: string;
}

export interface RepoSearchOptions {
  query: string;
  target: string;
  cwd: string;
  limit: number;
  mode?: "fixed" | "regex";
  caseSensitive?: boolean;
  globs?: string[];
  context?: ToolContext;
}

export interface RepoSymbolSearchOptions {
  symbol: string;
  target: string;
  cwd: string;
  limit: number;
  globs?: string[];
  context?: ToolContext;
}

export async function searchRepo(options: RepoSearchOptions): Promise<RepoSearchMatch[]> {
  const globs = options.globs?.filter((value) => value.length > 0) ?? [];

  try {
    const result = await runExecFile(
      "rg",
      buildRgArgs({
        ...options,
        globs
      }),
      {
        cwd: options.cwd,
        noPty: true
      }
    );

    return parseSearchMatches(`${result.stdout}${result.stderr}`, options.limit);
  } catch (error) {
    if (!isMissingBinary(error)) {
      throw error;
    }

    return fallbackSearch({
      ...options,
      globs,
      context: options.context as any
    });
  }
}

export async function searchRepoSymbol(options: RepoSymbolSearchOptions): Promise<RepoSearchMatch[]> {
  const symbolRegex = `\\b${escapeRegex(options.symbol)}\\b`;
  const candidates = await searchRepo({
    query: symbolRegex,
    target: options.target,
    cwd: options.cwd,
    limit: Math.max(options.limit * 6, options.limit),
    mode: "regex",
    caseSensitive: true,
    globs: options.globs ?? [],
    context: options.context as any
  });

  return candidates
    .sort((left, right) => {
      const scoreDelta = scoreSymbolLine(right.lineText, options.symbol) - scoreSymbolLine(left.lineText, options.symbol);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const fileDelta = left.filePath.localeCompare(right.filePath);
      return fileDelta !== 0 ? fileDelta : left.lineNumber - right.lineNumber;
    })
    .slice(0, options.limit);
}

function buildRgArgs(options: RepoSearchOptions & { globs: string[] }): string[] {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(options.limit),
    "--glob",
    "!.git/",
    "--glob",
    "!node_modules/"
  ];

  if (options.mode !== "regex") {
    args.push("--fixed-strings");
  }

  args.push(options.caseSensitive === true ? "--case-sensitive" : "--smart-case");

  for (const glob of options.globs) {
    args.push("--glob", glob);
  }

  args.push(options.query, options.target);
  return args;
}

function parseSearchMatches(output: string, limit: number): RepoSearchMatch[] {
  const matches: RepoSearchMatch[] = [];

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

async function fallbackSearch(options: RepoSearchOptions & { globs: string[]; context?: ToolContext }): Promise<RepoSearchMatch[]> {
  // If we have a performance-capable context, offload to Go backend for speed
  if (options.context?.performance.fastSearch) {
    const goMatches = await options.context.performance.fastSearch(options.query, options.target, {
      limit: options.limit,
      regex: options.mode === "regex"
    });
    if (goMatches) {
      return goMatches;
    }
  }

  const matches: RepoSearchMatch[] = [];
  const targetStats = await stat(options.target);

  if (targetStats.isFile()) {
    await searchFile(options, options.target, matches);
    return matches;
  }

  const queue = [options.target];

  while (queue.length > 0 && matches.length < options.limit) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= options.limit) {
        break;
      }

      if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
        continue;
      }

      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.isFile()) {
        const relativePath = path.relative(options.target, entryPath);
        const isMatch = matchesGlob(relativePath, options.globs);
        if (isMatch) {
          await searchFile(options, entryPath, matches);
        }
      }
    }
  }

  return matches;
}

async function searchFile(
  options: RepoSearchOptions,
  filePath: string,
  matches: RepoSearchMatch[]
): Promise<void> {
  try {
    const content = await readFile(filePath);

    if (content.includes(0)) {
      return;
    }

    const text = content.toString("utf8");
    const lines = text.split("\n");
    const matcher = buildMatcher(options);

    for (const [index, line] of lines.entries()) {
      if (!matcher(line)) {
        continue;
      }

      matches.push({
        filePath,
        lineNumber: index + 1,
        lineText: line
      });

      if (matches.length >= options.limit) {
        return;
      }
    }
  } catch {
    // Skip unreadable files in the fallback path.
  }
}

function buildMatcher(options: RepoSearchOptions): (line: string) => boolean {
  if (options.mode === "regex") {
    const flags = options.caseSensitive === true ? "" : "i";
    const pattern = new RegExp(options.query, flags);
    return (line) => pattern.test(line);
  }

  const needle = options.caseSensitive === true ? options.query : options.query.toLowerCase();
  return (line) => {
    const haystack = options.caseSensitive === true ? line : line.toLowerCase();
    return haystack.includes(needle);
  };
}

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRECTORIES.has(name);
}

function scoreSymbolLine(lineText: string, symbol: string): number {
  const trimmed = lineText.trim();
  const exactName = escapeRegex(symbol);
  const definitionPatterns = [
    new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${exactName}\\b`),
    new RegExp(`^(export\\s+)?class\\s+${exactName}\\b`),
    new RegExp(`^(export\\s+)?interface\\s+${exactName}\\b`),
    new RegExp(`^(export\\s+)?type\\s+${exactName}\\b`),
    new RegExp(`^(export\\s+)?enum\\s+${exactName}\\b`),
    new RegExp(`^(export\\s+)?(const|let|var)\\s+${exactName}\\b`),
    new RegExp(`^fn\\s+${exactName}\\b`),
    new RegExp(`^struct\\s+${exactName}\\b`),
    new RegExp(`^trait\\s+${exactName}\\b`)
  ];

  for (const [index, pattern] of definitionPatterns.entries()) {
    if (pattern.test(trimmed)) {
      return 100 - index;
    }
  }

  if (new RegExp(`\\b${exactName}\\s*[:=]\\s*(async\\s*)?\\(`).test(trimmed)) {
    return 80;
  }

  if (new RegExp(`\\b${exactName}\\b`).test(trimmed)) {
    return trimmed.includes("export ") ? 60 : 40;
  }

  return 0;
}

function matchesGlob(filePath: string, globs: string[]): boolean {
  if (globs.length === 0) {
    return true;
  }

  const normalized = filePath.split(path.sep).join("/");
  return globs.some((glob) => {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "___DSTAR_SLASH___")
      .replace(/\/\*\*/g, "___SLASH_DSTAR___")
      .replace(/\*\*/g, "___DSTAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DSTAR_SLASH___/g, "(.*\/)?")
      .replace(/___SLASH_DSTAR___/g, "(\/.*)?")
      .replace(/___DSTAR___/g, ".*");
    return new RegExp(`^${escaped}$`).test(normalized) || new RegExp(`/${escaped}$`).test(normalized);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissingBinary(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
