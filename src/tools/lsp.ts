import { readFile, stat } from "node:fs/promises";
import { runShellCommand } from "../process-utils.js";
import { searchRepo } from "./repo-search.js";
import type { ToolSpec } from "../types.js";
import path from "node:path";

export function createLspTools(): ToolSpec[] {
  return [getDiagnosticsTool, findReferencesTool, listExportsTool];
}

const getDiagnosticsTool: ToolSpec = {
  name: "get_diagnostics",
  description: "Get compiler errors and warnings for the project. Automatically detects TypeScript, Go, or Python to run the appropriate check.",
  jsonSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    // Try to auto-detect language
    const hasFile = async (name: string) => {
      try {
        const p = await context.paths.ensureReadable(path.join(context.workspaceRoot, name));
        await stat(p);
        return true;
      } catch {
        return false;
      }
    };

    let cmd = "";
    if (await hasFile("tsconfig.json")) {
      cmd = "npx tsc --noEmit";
    } else if (await hasFile("go.mod")) {
      cmd = "go build ./...";
    } else if (await hasFile("pyproject.toml") || await hasFile("requirements.txt")) {
      cmd = "python -m py_compile $(find . -name '*.py')"; // simple syntax check
    } else {
      return {
        summary: "No supported project type detected",
        content: "Could not find tsconfig.json, go.mod, or pyproject.toml to run diagnostics.",
        isError: true
      };
    }

    const result = await runShellCommand(cmd, { cwd: context.workspaceRoot, timeoutMs: 30000 });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    
    if (result.exitCode === 0) {
      return { summary: "No errors found", content: "No errors or warnings found.", isError: false };
    }

    return {
      summary: `Found errors using ${cmd.split(" ")[0]}`,
      content: output || "(no output but command failed)",
      isError: true // Not necessarily a tool error, but indicates code errors
    };
  }
};

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
    
    // Use the existing searchRepo functionality for semantic boundaries
    const matches = await searchRepo({
      query: symbol,
      target: ".",
      cwd: context.workspaceRoot,
      limit: 50,
      mode: "fixed",
      caseSensitive: true
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      // TS/JS
      if ((ext === ".ts" || ext === ".js" || ext === ".tsx" || ext === ".jsx") && 
          (line.startsWith("export ") || line.startsWith("module.exports"))) {
        exports.push(`${i + 1}: ${line}`);
      }
      // Python
      else if (ext === ".py" && (line.startsWith("def ") || line.startsWith("class "))) {
        exports.push(`${i + 1}: ${line}`);
      }
      // Go
      else if (ext === ".go" && (line.startsWith("func ") || line.startsWith("type ")) && /[A-Z]/.test(line.charAt(5))) {
        exports.push(`${i + 1}: ${line}`);
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
