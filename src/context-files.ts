import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { ensureAppPaths } from "./xdg.js";
import type { ContextFileSettings } from "./types.js";

const DEFAULT_RULES_FILE = "core.md";
const DEFAULT_RULES = `# CORE REASONING & TOOL PROTOCOL (CRITICAL)
1. PLAN BEFORE ACTING: Decompose complex tasks into ordered subtasks. Identify unknowns, risks, and dependencies before touching any file. State your plan explicitly for non-trivial work.
2. EMPIRICAL VERIFICATION -- NO HALLUCINATIONS: Never assume file contents, project structure, API signatures, or command availability. Read before you write. Grep before you guess. Stat before you create.
3. VALIDATE EVERY CHANGE: After write_file, apply_patch, or run_shell, confirm the change took effect. Run the relevant test, lint, or compile step. If it fails, diagnose and fix -- do not proceed on a broken foundation.
4. USE THE RIGHT TOOL: Prefer search_repo over shell grep, read_file over cat, apply_patch for surgical edits over full rewrites. Reserve run_shell for tasks no built-in tool covers.
5. INCREMENTAL, REVERSIBLE STEPS: Make the smallest change that moves the task forward. Verify. Then proceed. Never batch unverified changes -- one silent failure can corrupt the entire task.
6. HANDLE ERRORS EXPLICITLY: If a tool call fails or returns unexpected output, stop, analyse the error, and adapt. Never silently swallow errors or continue as if they succeeded.
7. CONCISE COMMUNICATION: Be terse. Narrate intent and blockers, not tool mechanics. One sentence per action is usually enough.

# AGENTIC CODING PRINCIPLES
- CONTEXT FIRST: Before editing any file, read its full relevant section. Blind edits introduce regressions. Understand the call-site, the type signatures, and the surrounding invariants.
- DEPENDENCY AWARENESS: When adding or upgrading a package, check the existing lockfile and package manifest first. Confirm version compatibility. Prefer pinned versions in new dependencies.
- TEST-DRIVEN CONFIRMATION: After implementing a feature or fix, locate or write a minimal test or reproducer and run it. A passing test is the only acceptable proof of correctness.
- SCOPE DISCIPLINE: Fix what you were asked to fix. If you discover adjacent issues, report them but do not silently refactor unrelated code. Scope creep breaks reviewer trust.
- IDEMPOTENT OPERATIONS: Prefer changes that are safe to run multiple times. Guard file creation with existence checks. Guard shell commands with dry-run flags where available.
- RESPECT PROJECT CONVENTIONS: Match the existing code style, naming patterns, import ordering, and file layout. Read a neighbouring file for 30 seconds before writing a new one.
- SECURITY BY DEFAULT: Never embed secrets, tokens, or credentials. Prefer env-var lookups. Flag any code path that logs, stores, or transmits user data.

# WORKFLOW PLAYBOOK
- Exploration : \`search_repo\` or directory listing -> build a mental map before touching anything.
- Explicit file paths : if the user already named a specific file, use \`read_file\` or \`read_file_chunk\` before \`search_repo\`.
- Comprehension : \`read_file\` on every file you intend to modify. Understand the full context.
- Implementation : \`apply_patch\` for targeted edits; \`write_file\` only for new files or full rewrites.
- Verification : run tests/linters via \`run_shell\`; read back changed files to confirm correctness.
- Long-running tasks : set \`timeout_ms\` explicitly for builds and test suites. Use \`sleep\` between polling steps.
- Uncertainty : use \`web_search\` or \`stack_overflow_search\` for unfamiliar APIs, error messages, or version quirks -- never guess.
- Skills : invoke the \`skill\` tool (list / load / read / pin / unpin) whenever a task aligns with an available skill.
- Shell fallback : use \`run_shell\` only when no built-in tool suffices. If a command requires interaction or elevated privileges, tell the user to run it manually.

Do not repeat identical tool calls in the same turn. Treat follow-up requests as continuing the current task.
`;

const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml"
]);

export async function loadRulesPrompt(settings: ContextFileSettings): Promise<string | null> {
  const paths = await ensureAppPaths();
  await ensureDefaultRules(paths.rulesDir);
  return loadContextPrompt(paths.rulesDir, "Rules", settings);
}

export async function loadMemoriesPrompt(settings: ContextFileSettings): Promise<string | null> {
  const paths = await ensureAppPaths();
  return loadContextPrompt(paths.memoriesDir, "Persistent Memory", settings, {
    allowFile: (name) => name !== "raw_memories.md"
  });
}

async function ensureDefaultRules(rulesDir: string): Promise<void> {
  const entries = await readdir(rulesDir, { withFileTypes: true });
  const hasRules = entries.some((entry) => entry.isFile() && isAllowedContextFile(entry.name));
  if (!hasRules) {
    await writeFile(path.join(rulesDir, DEFAULT_RULES_FILE), `${DEFAULT_RULES.trim()}\n`, "utf8");
  }
}

async function loadContextPrompt(
  dir: string,
  title: string,
  settings: ContextFileSettings,
  options: {
    allowFile?: (fileName: string) => boolean;
  } = {}
): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isAllowedContextFile(entry.name))
    .filter((entry) => options.allowFile?.(entry.name) ?? true)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0 || settings.maxFiles <= 0 || settings.maxTotalBytes <= 0) {
    return null;
  }

  const selected = files.slice(0, settings.maxFiles);
  const lines: string[] = [`# ${title}`];
  let totalBytes = 0;

  for (const name of selected) {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const normalized = normalizeText(raw);
    if (!normalized) {
      continue;
    }

    let content = truncate(normalized, settings.maxFileBytes);
    if (!content) {
      continue;
    }
    const remaining = settings.maxTotalBytes - totalBytes;
    if (remaining <= 0) {
      break;
    }

    if (content.length > remaining) {
      content = truncate(content, remaining);
      if (!content) {
        break;
      }
    }

    totalBytes += content.length;
    lines.push(`## ${name}`, content);
    if (totalBytes >= settings.maxTotalBytes) {
      break;
    }
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function truncate(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (value.length <= maxBytes) {
    return value;
  }
  if (maxBytes <= 3) {
    return value.slice(0, maxBytes);
  }
  return `${value.slice(0, maxBytes - 3)}...`;
}

function isAllowedContextFile(fileName: string): boolean {
  return ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}
