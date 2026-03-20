import { readFile, stat, readdir } from "node:fs/promises";
import { runShellCommand } from "../process-utils.js";
import { searchRepo } from "./repo-search.js";
import { detectLanguageByProject, detectLanguageByExtension, LANGUAGES } from "./languages.js";
import { checkFileSyntaxWithTreeSitter, checkSyntaxWithTreeSitter, formatDiagnostics } from "./tree-sitter-check.js";
import type { LanguageEntry } from "./languages.js";
import type { ToolResult, ToolSpec, ToolVerification } from "../types.js";
import path from "node:path";

export function createLspTools(): ToolSpec[] {
  return [getDiagnosticsTool, findReferencesTool, listExportsTool];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Check whether a CLI binary is available on this machine.
 * Uses `which` on Unix or `where` on Windows — fully cross-platform.
 */
async function commandExists(name: string): Promise<boolean> {
  const checkCmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
  try {
    const result = await runShellCommand(checkCmd, { cwd: ".", timeoutMs: 5000, noPty: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// get_diagnostics — Two-tier: native toolchain → tree-sitter fallback
// ---------------------------------------------------------------------------

const getDiagnosticsTool: ToolSpec = {
  name: "get_diagnostics",
  description:
    "Get compiler errors and warnings for the project. " +
    "Supports TypeScript, JavaScript, Go, Python, Rust, C, C++, Java, and Ruby. " +
    "Uses the native toolchain when available; falls back to tree-sitter syntax checking otherwise.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional file or directory to diagnose. Defaults to the workspace root."
      }
    },
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const pathArg = typeof args.path === "string" && args.path.trim().length > 0
      ? await context.paths.ensureReadable(args.path)
      : null;

    if (pathArg) {
      const targetStats = await stat(pathArg);
      if (targetStats.isFile()) {
        return runFileDiagnostics(pathArg, context.workspaceRoot);
      }
      return runProjectDiagnostics(pathArg);
    }

    return runProjectDiagnostics(context.workspaceRoot);
  }
};

async function runProjectDiagnostics(root: string): Promise<ToolResult> {
    // 1. Scan workspace for project marker files
    const existingFiles = new Set<string>();
    try {
      const entries = await readdir(root);
      for (const e of entries) existingFiles.add(e);
    } catch {
      return {
        summary: "Cannot read workspace",
        content: "Failed to list workspace root directory.",
        isError: true
      };
    }

    const lang = detectLanguageByProject(existingFiles);

    if (!lang) {
      const supported = LANGUAGES.map(l => l.projectFiles.join("/")).join(", ");
      return {
        summary: "No supported project type detected",
        content:
          `Could not detect a project type. Looked for: ${supported}.\n` +
          "Make sure you are in a project root with a recognizable config file.",
        isError: true
      };
    }

    // 2. Tier 1 — try native toolchain if the binary is installed
    if (lang.nativeCheck) {
      const binAvailable = await commandExists(lang.nativeCheck.binary);
      if (binAvailable) {
        return runNativeCheck(lang, root);
      }
    }

    // 3. Tier 2 — tree-sitter fallback (zero external deps)
    if (lang.treeSitterWasmUrl) {
      return runTreeSitterCheck(lang, root);
    }

    // 4. No checker available at all for this language
    return {
      summary: `No diagnostics available for ${lang.label}`,
      content:
        `Detected a ${lang.label} project but the native toolchain (${lang.nativeCheck?.binary ?? "n/a"}) is not installed ` +
        "and no tree-sitter grammar is configured for fallback checking.",
      isError: true
    };
}

async function runNativeCheck(lang: LanguageEntry, cwd: string) {
  const cmd = lang.nativeCheck!.command;
  const result = await runShellCommand(cmd, { cwd, timeoutMs: 60_000 });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

  if (result.exitCode === 0) {
    return withVerification({
      summary: `${lang.label}: no errors found (${lang.nativeCheck!.binary})`,
      content: "No errors or warnings found.",
      isError: false
    }, {
      kind: "diagnostics",
      trusted: true,
      passed: true,
      summary: `${lang.label} diagnostics`,
      scopePaths: [cwd]
    });
  }

  return withVerification({
    summary: `${lang.label}: errors found via ${lang.nativeCheck!.binary}`,
    content: output || "(no output but command failed)",
    isError: true
  }, {
    kind: "diagnostics",
    trusted: true,
    passed: false,
    summary: `${lang.label} diagnostics`,
    scopePaths: [cwd]
  });
}

async function runTreeSitterCheck(lang: LanguageEntry, cwd: string) {
  const diagnostics = await checkSyntaxWithTreeSitter(
    cwd,
    lang.extensions,
    lang.treeSitterWasmUrl!
  );

  if (diagnostics === null) {
    return {
      summary: `Tree-sitter unavailable for ${lang.label}`,
      content:
        "Could not initialize tree-sitter syntax checking. " +
        `Install the native ${lang.nativeCheck?.binary ?? lang.id} toolchain for full diagnostics.`,
      isError: true
    };
  }

  if (diagnostics.length === 0) {
    return withVerification({
      summary: `${lang.label}: no syntax errors (tree-sitter)`,
      content: "No syntax errors found via tree-sitter analysis.",
      isError: false
    }, {
      kind: "diagnostics",
      trusted: true,
      passed: true,
      summary: `${lang.label} syntax check`,
      scopePaths: [cwd]
    });
  }

  return withVerification({
    summary: `${lang.label}: ${diagnostics.length} syntax error(s) (tree-sitter)`,
    content: formatDiagnostics(diagnostics),
    isError: true
  }, {
    kind: "diagnostics",
    trusted: true,
    passed: false,
    summary: `${lang.label} syntax check`,
    scopePaths: [cwd]
  });
}

async function runFileDiagnostics(target: string, workspaceRoot: string): Promise<ToolResult> {
  const ext = path.extname(target);
  const lang = detectLanguageByExtension(ext);

  if (!lang) {
    return {
      summary: `No diagnostics available for ${target}`,
      content: `Could not determine a supported language for ${target}.`,
      isError: true
    };
  }

  if (lang.nativeCheck) {
    const binAvailable = await commandExists(lang.nativeCheck.binary);
    const fileCommand = buildFileDiagnosticsCommand(lang, target);
    if (binAvailable && fileCommand) {
      const cwd = path.dirname(target);
      const result = await runShellCommand(fileCommand, { cwd, timeoutMs: 60_000, noPty: true });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return withVerification({
        summary: result.exitCode === 0
          ? `${lang.label}: no errors found in ${target}`
          : `${lang.label}: errors found in ${target}`,
        content: output || (result.exitCode === 0 ? "No errors or warnings found." : "(no output but command failed)"),
        isError: (result.exitCode ?? 1) !== 0
      }, {
        kind: "diagnostics",
        trusted: true,
        passed: (result.exitCode ?? 1) === 0,
        summary: `${lang.label} diagnostics for ${path.basename(target)}`,
        scopePaths: [target]
      });
    }
  }

  if (lang.treeSitterWasmUrl) {
    const diagnostics = await checkFileSyntaxWithTreeSitter(target, workspaceRoot, lang.treeSitterWasmUrl);
    if (diagnostics === null) {
      return {
        summary: `Tree-sitter unavailable for ${lang.label}`,
        content:
          "Could not initialize tree-sitter syntax checking for this file. " +
          `Install the native ${lang.nativeCheck?.binary ?? lang.id} toolchain for diagnostics.`,
        isError: true
      };
    }

    if (diagnostics.length === 0) {
      return withVerification({
        summary: `${lang.label}: no syntax errors in ${target}`,
        content: "No syntax errors found via tree-sitter analysis.",
        isError: false
      }, {
        kind: "diagnostics",
        trusted: true,
        passed: true,
        summary: `${lang.label} syntax check for ${path.basename(target)}`,
        scopePaths: [target]
      });
    }

    return withVerification({
      summary: `${lang.label}: ${diagnostics.length} syntax error(s) in ${target}`,
      content: formatDiagnostics(diagnostics),
      isError: true
    }, {
      kind: "diagnostics",
      trusted: true,
      passed: false,
      summary: `${lang.label} syntax check for ${path.basename(target)}`,
      scopePaths: [target]
    });
  }

  return {
    summary: `No diagnostics available for ${target}`,
    content:
      `Detected ${lang.label} from the file extension, but no file-scoped checker is configured for ${target}.`,
    isError: true
  };
}

function buildFileDiagnosticsCommand(lang: LanguageEntry, target: string): string | null {
  const quoted = quoteShell(target);
  const ext = path.extname(target).toLowerCase();
  const jsxFlag = ext === ".tsx" || ext === ".jsx" ? "--jsx react-jsx " : "";
  switch (lang.id) {
    case "typescript":
      return `npx tsc --noEmit --pretty false ${jsxFlag}${quoted}`;
    case "javascript":
      return `npx tsc --noEmit --allowJs --checkJs --pretty false ${jsxFlag}${quoted}`;
    case "python":
      return `python3 -m py_compile ${quoted}`;
    case "ruby":
      return `ruby -c ${quoted}`;
    case "php":
      return `php -l ${quoted}`;
    case "bash":
      return `bash --norc -n ${quoted}`;
    default:
      return null;
  }
}

function withVerification(result: ToolResult, verification: ToolVerification): ToolResult {
  return {
    ...result,
    meta: {
      ...(result.meta ?? {}),
      verification
    }
  };
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

// ---------------------------------------------------------------------------
// find_references
// ---------------------------------------------------------------------------

const findReferencesTool: ToolSpec = {
  name: "find_references",
  description: "Find all usages of a symbol or function name across the codebase.",
  jsonSchema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "The name of the function, variable, or class to find."
      }
    },
    required: ["symbol"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const symbol = requiredString(args.symbol, "symbol");

    const matches = await searchRepo({
      query: symbol,
      target: ".",
      cwd: context.workspaceRoot,
      limit: 50,
      mode: "fixed",
      caseSensitive: true,
      context
    });

    if (matches.length === 0) {
      return { summary: `No references found for ${symbol}`, content: "(no matches)", isError: false };
    }

    const content = matches.map(m => `${m.filePath}:${m.lineNumber}: ${m.lineText}`).join("\n");
    return {
      summary: `Found ${matches.length} references for ${symbol}`,
      content,
      isError: false
    };
  }
};

// ---------------------------------------------------------------------------
// list_exports — uses language registry for extension matching
// ---------------------------------------------------------------------------

const listExportsTool: ToolSpec = {
  name: "list_exports",
  description: "List all exported functions, classes, and types from a file to quickly understand its API surface.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the source file."
      }
    },
    required: ["path"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureReadable(requiredString(args.path, "path"));

    const content = await readFile(target, "utf8");
    const lines = content.split("\n");

    const exports: string[] = [];
    const ext = path.extname(target);
    const lang = detectLanguageByExtension(ext);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      if (lang) {
        switch (lang.id) {
          case "typescript":
          case "javascript":
            if (line.startsWith("export ") || line.startsWith("module.exports")) {
              exports.push(`${i + 1}: ${line}`);
            }
            break;
          case "python":
            if (line.startsWith("def ") || line.startsWith("class ")) {
              exports.push(`${i + 1}: ${line}`);
            }
            break;
          case "go":
            if ((line.startsWith("func ") || line.startsWith("type ")) && /[A-Z]/.test(line.charAt(5))) {
              exports.push(`${i + 1}: ${line}`);
            }
            break;
          case "rust":
            if (line.startsWith("pub fn ") || line.startsWith("pub struct ") || line.startsWith("pub enum ") || line.startsWith("pub trait ")) {
              exports.push(`${i + 1}: ${line}`);
            }
            break;
          case "java":
            if (line.startsWith("public ")) {
              exports.push(`${i + 1}: ${line}`);
            }
            break;
          case "ruby":
            if (line.startsWith("def ") || line.startsWith("class ") || line.startsWith("module ")) {
              exports.push(`${i + 1}: ${line}`);
            }
            break;
          default:
            // Fallback heuristic for unknown languages
            if (line.startsWith("export ") || line.startsWith("pub ") || line.startsWith("public ")) {
              exports.push(`${i + 1}: ${line}`);
            }
        }
      } else {
        // No language match — try generic export heuristics
        if (line.startsWith("export ") || line.startsWith("module.exports") ||
          line.startsWith("pub ") || line.startsWith("public ")) {
          exports.push(`${i + 1}: ${line}`);
        }
      }
    }

    if (exports.length === 0) {
      return { summary: `No clear exports found in ${target}`, content: "(no exports matching heuristic)", isError: false };
    }

    return {
      summary: `Found ${exports.length} exports in ${target}`,
      content: exports.join("\n"),
      isError: false,
      referencedFiles: [target]
    };
  }
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
