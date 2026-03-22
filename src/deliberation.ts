import type { ReasoningEffort } from "./types.js";

export type TaskKind = "chat" | "explain" | "edit" | "review" | "audit" | "research";
export type TurnPlanStatus = "pending" | "in_progress" | "completed";
export type TurnPlanStage = "inspect" | "decide" | "execute" | "complete";

export interface TurnPlanStep {
  id: string;
  label: string;
  status: TurnPlanStatus;
}

export interface TurnPlan {
  taskKind: TaskKind;
  title: string;
  explanation: string | null;
  steps: TurnPlanStep[];
}

export interface TurnDeliberation {
  taskKind: TaskKind;
  reasoningEffort: ReasoningEffort | null;
  reasoningLabel: ReasoningEffort | "none";
  thinkingSummary: string | null;
  guidance: string | null;
  shouldShowThinking: boolean;
  plan: TurnPlan | null;
}

interface DeliberationOptions {
  configuredEffort?: ReasoningEffort | null;
  activeSkills?: string[];
}

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
  const guidance = (() => {
    if (ambiguousEdit) {
      return "This request is underspecified. If initial inspection does not identify a clear target or acceptance criteria, call ask_user before editing.";
    }
    if (taskKind === "explain" || taskKind === "chat" || taskKind === "research") {
      return "This is a read-only task. Read the necessary files, then respond with a clear answer. Do not run build, test, or shell commands unless the user explicitly asked. Do not call task_completed — just provide your answer directly.";
    }
    return "For non-trivial tasks, form a concise plan first, then execute incrementally and verify after each meaningful change.";
  })();

  return {
    taskKind,
    reasoningEffort,
    reasoningLabel,
    thinkingSummary: null,
    guidance,
    shouldShowThinking: taskKind !== "chat" && score >= 2,
    plan: null
  };
}

export function advanceTurnPlan(plan: TurnPlan | null, stage: TurnPlanStage): TurnPlan | null {
  if (!plan) {
    return null;
  }

  const next = cloneTurnPlan(plan);
  if (!next) {
    return null;
  }
  switch (stage) {
    case "inspect":
      setStepStatus(next, "inspect", "in_progress");
      break;
    case "decide":
      completeStep(next, "inspect");
      setStepStatus(next, "decide", "in_progress");
      break;
    case "execute":
      completeStep(next, "inspect");
      completeStep(next, "decide");
      setStepStatus(next, "execute", "in_progress");
      break;
    case "complete":
      for (const step of next.steps) {
        step.status = "completed";
      }
      break;
  }

  return next;
}

export function updateTurnPlan(
  plan: TurnPlan | null,
  options: {
    completed?: TurnPlanStep["id"][];
    inProgress?: TurnPlanStep["id"] | null;
  }
): TurnPlan | null {
  if (!plan) {
    return null;
  }

  const next = cloneTurnPlan(plan);
  if (!next) {
    return null;
  }
  const completed = new Set(options.completed ?? []);

  for (const step of next.steps) {
    if (completed.has(step.id)) {
      step.status = "completed";
      continue;
    }
    if (options.inProgress && step.id === options.inProgress) {
      step.status = "in_progress";
      continue;
    }
    if (step.status !== "completed") {
      step.status = "pending";
    }
  }

  return next;
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

function buildTurnPlan(taskKind: TaskKind, filePaths: string[], ambiguousEdit: boolean): TurnPlan {
  const target = filePaths.length > 0 ? formatTargets(filePaths) : "the relevant code and nearby context";
  switch (taskKind) {
    case "audit":
      return {
        taskKind,
        title: "Plan",
        explanation: "Inspect first, then validate the riskiest paths before reporting concrete findings.",
        steps: [
          { id: "inspect", label: `Inspect ${target} and trust boundaries`, status: "pending" },
          { id: "decide", label: "Decide which surfaces look riskiest", status: "pending" },
          { id: "execute", label: "Validate concrete abuse paths and edge cases", status: "pending" },
          { id: "summarize", label: "Summarize findings, impact, and mitigations", status: "pending" }
        ]
      };
    case "review":
      return {
        taskKind,
        title: "Plan",
        explanation: "Inspect first, then review the likely regression points before summarizing findings.",
        steps: [
          { id: "inspect", label: `Inspect ${target} and surrounding context`, status: "pending" },
          { id: "decide", label: "Decide the highest-risk review focus", status: "pending" },
          { id: "execute", label: "Check regressions, edge cases, and test gaps", status: "pending" },
          { id: "summarize", label: "Summarize findings with severity and references", status: "pending" }
        ]
      };
    case "edit":
      return {
        taskKind,
        title: "Plan",
        explanation: ambiguousEdit
          ? "Inspect first, clarify if the target stays fuzzy, then make the smallest safe change."
          : "Inspect first, then make the smallest safe change and verify it.",
        steps: [
          { id: "inspect", label: `Inspect ${target} and the current constraints`, status: "pending" },
          {
            id: "decide",
            label: ambiguousEdit ? "Clarify scope or choose the safest target" : "Choose the smallest safe change",
            status: "pending"
          },
          { id: "execute", label: "Apply the change without broad churn", status: "pending" },
          { id: "summarize", label: "Verify the result and summarize what changed", status: "pending" }
        ]
      };
    case "research":
      return {
        taskKind,
        title: "Plan",
        explanation: "Gather the constraints first, then compare viable options before recommending a path.",
        steps: [
          { id: "inspect", label: `Inspect ${target} and the relevant constraints`, status: "pending" },
          { id: "decide", label: "Decide which comparison criteria matter", status: "pending" },
          { id: "execute", label: "Compare viable options and tradeoffs", status: "pending" },
          { id: "summarize", label: "Recommend a path with concrete reasoning", status: "pending" }
        ]
      };
    case "chat":
      return {
        taskKind,
        title: "Plan",
        explanation: null,
        steps: []
      };
    default:
      return {
        taskKind,
        title: "Plan",
        explanation: "Inspect first, then trace the important flow before answering.",
        steps: [
          { id: "inspect", label: `Inspect ${target}`, status: "pending" },
          { id: "decide", label: "Decide which flows or components matter most", status: "pending" },
          { id: "execute", label: "Trace the main paths instead of guessing", status: "pending" },
          { id: "summarize", label: "Explain the result with concrete references", status: "pending" }
        ]
      };
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
  } else if (fileCount === 1) {
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

function setStepStatus(plan: TurnPlan, stepId: TurnPlanStep["id"], status: TurnPlanStatus): void {
  for (const step of plan.steps) {
    if (step.id === stepId) {
      step.status = status;
      continue;
    }
    if (status === "in_progress" && step.status === "in_progress") {
      step.status = "pending";
    }
  }
}

function completeStep(plan: TurnPlan, stepId: TurnPlanStep["id"]): void {
  for (const step of plan.steps) {
    if (step.id === stepId) {
      step.status = "completed";
    } else if (step.status === "in_progress") {
      step.status = "pending";
    }
  }
}

export function cloneTurnPlan(plan: TurnPlan | null): TurnPlan | null {
  if (!plan) {
    return null;
  }
  return {
    taskKind: plan.taskKind,
    title: plan.title,
    explanation: plan.explanation,
    steps: plan.steps.map((step) => ({ ...step }))
  };
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
