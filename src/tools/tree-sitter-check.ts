import { readFile, stat, mkdir, writeFile as fsWriteFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// web-tree-sitter exports both default and named — handle both
let Parser: any;
let parserInitialized = false;

async function ensureParser() {
    if (parserInitialized) return;
    parserInitialized = true;
    try {
        const mod = await import("web-tree-sitter");
        Parser = mod.default || mod;
        await Parser.init();
    } catch {
        Parser = null;
    }
}

export interface SyntaxDiagnostic {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    type: "ERROR" | "MISSING";
    context: string; // The surrounding source line
}

function grammarCacheDir(): string {
    return path.join(os.homedir(), ".cache", "vetala", "grammars");
}

async function ensureGrammarWasm(wasmUrl: string): Promise<string> {
    const cacheDir = grammarCacheDir();
    // Derive a stable filename from the URL
    const urlObj = new URL(wasmUrl);
    const filename = urlObj.pathname.split("/").filter(Boolean).pop() || "grammar.wasm";
    const cachedPath = path.join(cacheDir, filename);

    // Check if already cached
    try {
        await stat(cachedPath);
        return cachedPath;
    } catch {
        // Not cached yet — need to download
    }

    // Download
    const response = await fetch(wasmUrl);
    if (!response.ok) {
        throw new Error(`Failed to download grammar: ${response.status} from ${wasmUrl}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Ensure cache dir exists
    await mkdir(cacheDir, { recursive: true });
    await fsWriteFile(cachedPath, buffer);

    return cachedPath;
}

async function collectSourceFiles(
    dir: string,
    extensions: string[],
    maxFiles: number = 200
): Promise<string[]> {
    const IGNORE = new Set([
        "node_modules", ".git", "__pycache__", ".mypy_cache", "dist",
        "build", "target", "vendor", ".next", ".cache", "coverage"
    ]);

    const files: string[] = [];

    async function walk(currentDir: string) {
        if (files.length >= maxFiles) return;

        let entries;
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (files.length >= maxFiles) break;

            if (entry.isDirectory()) {
                if (!IGNORE.has(entry.name) && !entry.name.startsWith(".")) {
                    await walk(path.join(currentDir, entry.name));
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (extensions.includes(ext)) {
                    files.push(path.join(currentDir, entry.name));
                }
            }
        }
    }

    await walk(dir);
    return files;
}

function collectErrors(
    node: any,
    filePath: string,
    sourceLines: string[],
    results: SyntaxDiagnostic[]
) {
    if (node.type === "ERROR" || node.isMissing) {
        const line = node.startPosition.row;
        results.push({
            file: filePath,
            line: line + 1, // 1-indexed
            column: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            endColumn: node.endPosition.column + 1,
            type: node.isMissing ? "MISSING" : "ERROR",
            context: sourceLines[line] ?? ""
        });
    }
    for (let i = 0; i < node.childCount; i++) {
        collectErrors(node.child(i), filePath, sourceLines, results);
    }
}

export async function checkSyntaxWithTreeSitter(
    workspaceRoot: string,
    extensions: string[],
    wasmUrl: string
): Promise<SyntaxDiagnostic[] | null> {
    await ensureParser();
    if (!Parser) return null;

    let grammarPath: string;
    try {
        grammarPath = await ensureGrammarWasm(wasmUrl);
    } catch {
        return null; // Can't download grammar (offline, etc.)
    }

    const parser = new Parser();
    try {
        const language = await Parser.Language.load(grammarPath);
        parser.setLanguage(language);
    } catch {
        return null; // Grammar incompatible or corrupted
    }

    const files = await collectSourceFiles(workspaceRoot, extensions);
    if (files.length === 0) return [];

    const diagnostics: SyntaxDiagnostic[] = [];

    for (const filePath of files) {
        try {
            const source = await readFile(filePath, "utf8");
            const tree = parser.parse(source);
            const sourceLines = source.split("\n");
            const relPath = path.relative(workspaceRoot, filePath);
            collectErrors(tree.rootNode, relPath, sourceLines, diagnostics);
        } catch {
            // Skip unparseable files
        }
    }

    return diagnostics;
}

export async function isTreeSitterAvailable(): Promise<boolean> {
    await ensureParser();
    return Parser !== null;
}

export function formatDiagnostics(diagnostics: SyntaxDiagnostic[]): string {
    if (diagnostics.length === 0) return "No syntax errors found.";

    return diagnostics
        .map(d => {
            const loc = `${d.file}:${d.line}:${d.column}`;
            const tag = d.type === "MISSING" ? "MISSING token" : "SYNTAX ERROR";
            const ctx = d.context.trim();
            return `${loc}: ${tag}\n  ${ctx}`;
        })
        .join("\n\n");
}
