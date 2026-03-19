import type { ReasoningEffort } from "./types.js";

export interface TurnDeliberation {
  reasoningEffort: ReasoningEffort | null;
  reasoningLabel: ReasoningEffort | "none";
  thinkingSummary: string | null;
  guidance: string | null;
  shouldShowThinking: boolean;
}

interface DeliberationOptions {
  configuredEffort?: ReasoningEffort | null;
  activeSkills?: string[];
}

type TaskKind = "chat" | "explain" | "edit" | "review" | "audit" | "research";

const REVIEW_TERMS = ["review", "diff", "regression", "bug", "findings", "pr", "pull request"];
const AUDIT_TERMS = ["audit", "security", "vulnerability", "threat", "unsafe", "exploit"];
const EDIT_TERMS = ["fix", "refactor", "implement", "add", "change", "update", "improve", "optimize", "patch"];
const EXPLAIN_TERMS = ["explain", "why", "how", "walk through", "understand", "codebase", "architecture"];
const RESEARCH_TERMS = ["compare", "recommend", "best", "choose", "which", "tradeoff"];
const AMBIGUOUS_EDIT_TERMS = ["fix this", "improve this", "refactor this", "optimize this", "clean this", "make it better"];

export function analyzeTurnDeliberation(userInput: string, options: DeliberationOptions = {}): TurnDeliberation {
  const normalized = normalize(userInput);
  const configuredEffort = options.configuredEffort ?? null;
  const filePaths = extractLikelyPaths(userInput);
  const taskKind = classifyTask(normalized);
  const ambiguousEdit = isAmbiguousEditRequest(normalized, filePaths.length);
  const score = scoreComplexity(normalized, taskKind, filePaths.length, options.activeSkills ?? [], ambiguousEdit);

  const reasoningEffort = configuredEffort ?? selectDynamicEffort(taskKind, score);
  const reasoningLabel = reasoningEffort ?? "none";
  const shouldShowThinking = taskKind !== "chat" && score >= 2;
  const guidance = ambiguousEdit
    ? "This request is underspecified. If initial inspection does not identify a clear target or acceptance criteria, call ask_user before editing."
    : "For non-trivial tasks, form a concise plan first, then execute incrementally and verify after each meaningful change.";

  return {
    reasoningEffort,
    reasoningLabel,
    thinkingSummary: shouldShowThinking ? buildThinkingSummary(taskKind, filePaths, ambiguousEdit) : null,
    guidance,
    shouldShowThinking
  };
}

export function phaseForTool(toolName: string): string {
  switch (toolName) {
    case "list_dir":
    case "search_repo":
    case "search_files":
    case "read_file":
    case "read_file_chunk":
    case "read_symbol":
    case "git_review":
    case "git_diff":
    case "git_log":
    case "git_blame":
    case "find_references":
    case "list_exports":
    case "get_diagnostics":
      return "inspecting";
    case "write_file":
    case "append_to_file":
    case "apply_patch":
    case "replace_in_file":
    case "move_file":
    case "delete_file":
    case "undo_last_edit":
      return "editing";
    case "ask_user":
      return "clarifying";
    case "run_shell":
    case "web_search":
    case "read_docs":
      return "verifying";
    default:
      return "working";
  }
}

function classifyTask(normalized: string): TaskKind {
  if (!normalized || isGreeting(normalized)) {
    return "chat";
  }
  if (containsAny(normalized, AUDIT_TERMS)) {
    return "audit";
  }
  if (containsAny(normalized, REVIEW_TERMS)) {
    return "review";
  }
  if (containsAny(normalized, RESEARCH_TERMS)) {
    return "research";
  }
  if (containsAny(normalized, EDIT_TERMS)) {
    return "edit";
  }
  if (containsAny(normalized, EXPLAIN_TERMS) || normalized.includes("?")) {
    return "explain";
  }
  return normalized.split(/\s+/).length <= 3 ? "chat" : "explain";
}

function scoreComplexity(
  normalized: string,
  taskKind: TaskKind,
  fileCount: number,
  activeSkills: string[],
  ambiguousEdit: boolean
): number {
  let score = 0;

  switch (taskKind) {
    case "audit":
      score += 6;
      break;
    case "review":
      score += 5;
      break;
    case "edit":
      score += 4;
      break;
    case "research":
      score += 3;
      break;
    case "explain":
      score += 2;
      break;
    default:
      break;
  }

  if (normalized.includes("codebase") || normalized.includes("entire repo") || normalized.includes("whole project")) {
    score += 3;
  }
  if (normalized.includes("performance") || normalized.includes("architecture")) {
    score += 2;
  }
  if (fileCount >= 2) {
    score += 2;
  } else if (fileCount == 1) {
    score += 1;
  }
  if (normalized.split(/\s+/).length >= 14) {
    score += 1;
  }
  if (activeSkills.length > 0) {
    score += 1;
  }
  if (ambiguousEdit) {
    score += 1;
  }

  return score;
}

function selectDynamicEffort(taskKind: TaskKind, score: number): ReasoningEffort | null {
  if (taskKind === "chat" && score < 2) {
    return null;
  }
  if (score >= 6) {
    return "high";
  }
  if (score >= 2) {
    return "medium";
  }
  return "low";
}

function buildThinkingSummary(taskKind: TaskKind, filePaths: string[], ambiguousEdit: boolean): string {
  const target = filePaths.length > 0 ? formatTargets(filePaths) : "the relevant files and nearby context";
  const lines = (() => {
    switch (taskKind) {
      case "audit":
        return [
          `inspect ${target} before making security claims`,
          "look for correctness, safety, and abuse-path risks",
          "report concrete findings and missing tests"
        ];
      case "review":
        return [
          `inspect ${target} and surrounding context first`,
          "check for regressions, edge cases, and test gaps",
          "summarize findings with clear severity and file references"
        ];
      case "edit":
        return [
          `inspect ${target} before changing anything`,
          ambiguousEdit
            ? "ask a clarifying question if the target or success criteria stay unclear"
            : "make the smallest targeted change that satisfies the request",
          "verify the result after editing"
        ];
      case "research":
        return [
          "gather the relevant code or constraints first",
          "compare options before committing to one path",
          "explain the tradeoffs clearly"
        ];
      default:
        return [
          `inspect ${target} before answering`,
          "trace the important flow instead of guessing",
          "respond with concrete references and next steps"
        ];
    }
  })();

  return lines.map((line) => `- ${line}`).join("\n");
}

function isAmbiguousEditRequest(normalized: string, fileCount: number): boolean {
  if (fileCount > 0) {
    return false;
  }
  if (!containsAny(normalized, EDIT_TERMS)) {
    return false;
  }
  return AMBIGUOUS_EDIT_TERMS.some((term) => normalized.includes(term));
}

function extractLikelyPaths(input: string): string[] {
  const matches = input.match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set(matches)];
}

function formatTargets(filePaths: string[]): string {
  if (filePaths.length === 1) {
    return filePaths[0]!;
  }
  if (filePaths.length === 2) {
    return `${filePaths[0]} and ${filePaths[1]}`;
  }
  return `${filePaths[0]} and related files`;
}

function containsAny(normalized: string, terms: string[]): boolean {
  return terms.some((term) => {
    const candidate = term.trim().toLowerCase();
    if (candidate.includes(" ")) {
      return normalized.includes(candidate);
    }
    return new RegExp(`\\b${escapeRegex(candidate)}\\b`).test(normalized);
  });
}

function isGreeting(normalized: string): boolean {
  return normalized === "hi" || normalized === "hello" || normalized === "hey";
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
