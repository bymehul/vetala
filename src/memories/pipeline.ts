import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createProviderClient, withSystemMessage } from "../providers/index.js";
import { ensureAppPaths } from "../xdg.js";
import type { EffectiveConfig, SessionState } from "../types.js";
import { SessionStore } from "../session-store.js";

const STATE_FILE = "state.json";
const ROLLOUT_SUMMARIES_DIR = "rollout_summaries";
const MEMORY_SUMMARY_FILE = "memory_summary.md";
const MEMORY_CANONICAL_FILE = "MEMORY.md";
const RAW_MEMORIES_FILE = "raw_memories.md";

let activePipeline: Promise<void> | null = null;

interface Stage1Record {
  sessionId: string;
  workspaceRoot: string;
  updatedAt: string;
  createdAt: string;
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug?: string;
  lastUsedAt?: string;
  usageCount: number;
}

interface Phase2State {
  lastSelection: string[];
  lastRunAt: string | null;
}

interface MemoryState {
  stage1: Record<string, Stage1Record>;
  phase2: Phase2State;
}

export function startMemoriesPipeline(config: EffectiveConfig, store: SessionStore): void {
  if (!config.memories.enabled) {
    return;
  }
  if (activePipeline) {
    return;
  }
  activePipeline = runMemoriesPipeline(config, store)
    .catch(() => {
      // Best-effort background pipeline.
    })
    .finally(() => {
      activePipeline = null;
    });
}

async function runMemoriesPipeline(config: EffectiveConfig, store: SessionStore): Promise<void> {
  if (!config.memories.enabled) {
    return;
  }

  const paths = await ensureAppPaths();
  const root = paths.memoriesDir;
  await mkdir(path.join(root, ROLLOUT_SUMMARIES_DIR), { recursive: true });
  const state = await loadState(root);

  const candidates = await selectCandidates(store, config);
  for (const item of candidates) {
    const session = await store.loadSession(item.id);
    if (!shouldProcessSession(session, state)) {
      continue;
    }
    const record = await extractMemoryForSession(session, config);
    if (!record) {
      continue;
    }
    state.stage1[session.id] = record;
  }

  await saveState(root, state);
  await consolidateMemories(root, state, config);
  await saveState(root, state);
}

async function selectCandidates(
  store: SessionStore,
  config: EffectiveConfig
): Promise<Array<{ id: string; updatedAt: string }>> {
  const sessions = await store.listSessions();
  const now = Date.now();
  const maxAgeMs = config.memories.maxRolloutAgeDays * 24 * 60 * 60 * 1000;
  const minIdleMs = config.memories.minRolloutIdleHours * 60 * 60 * 1000;

  const eligible = sessions.filter((session) => {
    const updatedAtMs = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      return false;
    }
    const ageMs = now - updatedAtMs;
    if (ageMs < minIdleMs) {
      return false;
    }
    if (ageMs > maxAgeMs) {
      return false;
    }
    return true;
  });

  eligible.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return eligible.slice(0, config.memories.maxRolloutsPerStartup);
}

function shouldProcessSession(session: SessionState, state: MemoryState): boolean {
  if (session.messages.length === 0) {
    return false;
  }
  const existing = state.stage1[session.id];
  if (!existing) {
    return true;
  }
  return existing.updatedAt !== session.updatedAt;
}

async function extractMemoryForSession(
  session: SessionState,
  config: EffectiveConfig
): Promise<Stage1Record | null> {
  const providerConfig = config.providers[session.provider];
  if (!providerConfig || !providerConfig.authValue) {
    return null;
  }

  const model = config.memories.extractModel ?? session.model;
  const client = createProviderClient(providerConfig);
  const transcript = buildTranscript(session, config.memories.rolloutMaxChars);
  const systemPrompt = [
    "You are a memory extraction agent.",
    "Return a single JSON object with keys:",
    "- raw_memory: detailed, durable facts and preferences.",
    "- rollout_summary: a concise summary of the session.",
    "- rollout_slug: optional short kebab-case label (<= 60 chars).",
    "Do not include markdown fences or extra commentary."
  ].join("\n");
  const userPrompt = [
    `workspace_root: ${session.workspaceRoot}`,
    `session_id: ${session.id}`,
    `updated_at: ${session.updatedAt}`,
    "",
    "transcript:",
    transcript
  ].join("\n");

  let responseText = "";
  try {
    const response = await client.complete({
      model,
      messages: withSystemMessage(systemPrompt, [{ role: "user", content: userPrompt }]),
      temperature: 0.2
    });
    responseText = response.content ?? "";
  } catch {
    return null;
  }

  const parsed = parseMemoryJson(responseText);
  if (!parsed) {
    return null;
  }

  const rawMemory = truncate(parsed.raw_memory?.trim() ?? "", config.memories.rawMemoryMaxChars);
  const rolloutSummary = truncate(parsed.rollout_summary?.trim() ?? "", config.memories.rolloutSummaryMaxChars);
  if (!rawMemory || !rolloutSummary) {
    return null;
  }

  const rolloutSlug = normalizeSlug(parsed.rollout_slug);
  const record: Stage1Record = {
    sessionId: session.id,
    workspaceRoot: session.workspaceRoot,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    rawMemory,
    rolloutSummary,
    usageCount: 0
  };
  if (rolloutSlug) {
    record.rolloutSlug = rolloutSlug;
  }
  return record;
}

async function consolidateMemories(
  root: string,
  state: MemoryState,
  config: EffectiveConfig
): Promise<void> {
  const records = selectPhase2Inputs(state, config);
  const now = new Date().toISOString();
  for (const record of records) {
    record.lastUsedAt = now;
    record.usageCount += 1;
  }

  await writeRawMemories(root, records);
  await writeRolloutSummaries(root, records);
  await writeMemorySummary(root, records, config);

  state.phase2.lastSelection = records.map((record) => record.sessionId);
  state.phase2.lastRunAt = now;
}

function selectPhase2Inputs(state: MemoryState, config: EffectiveConfig): Stage1Record[] {
  const now = Date.now();
  const maxAgeMs = config.memories.maxRolloutAgeDays * 24 * 60 * 60 * 1000;
  const maxUnusedMs = config.memories.maxUnusedDays * 24 * 60 * 60 * 1000;

  const candidates = Object.values(state.stage1).filter((record) => {
    const updatedAtMs = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      return false;
    }
    if (now - updatedAtMs > maxAgeMs) {
      return false;
    }
    if (record.lastUsedAt) {
      const lastUsedMs = Date.parse(record.lastUsedAt);
      if (Number.isFinite(lastUsedMs) && now - lastUsedMs > maxUnusedMs) {
        return false;
      }
    }
    return true;
  });

  candidates.sort((left, right) => {
    if (right.usageCount !== left.usageCount) {
      return right.usageCount - left.usageCount;
    }
    const rightUsed = right.lastUsedAt ?? right.updatedAt;
    const leftUsed = left.lastUsedAt ?? left.updatedAt;
    return rightUsed.localeCompare(leftUsed);
  });

  return candidates.slice(0, config.memories.maxRawMemoriesForConsolidation);
}

async function writeRawMemories(root: string, records: Stage1Record[]): Promise<void> {
  const lines: string[] = ["# Raw Memories", ""];
  if (records.length === 0) {
    lines.push("No raw memories yet.");
    await writeFile(path.join(root, RAW_MEMORIES_FILE), `${lines.join("\n")}\n`, "utf8");
    return;
  }

  lines.push("Merged stage-1 raw memories (latest first):", "");
  for (const record of records) {
    lines.push(`## Session ${record.sessionId}`);
    lines.push(`updated_at: ${record.updatedAt}`);
    lines.push(`workspace_root: ${record.workspaceRoot}`);
    if (record.rolloutSlug) {
      lines.push(`rollout_slug: ${record.rolloutSlug}`);
    }
    lines.push("");
    lines.push(record.rawMemory.trim());
    lines.push("");
  }
  await writeFile(path.join(root, RAW_MEMORIES_FILE), `${lines.join("\n")}\n`, "utf8");
}

async function writeRolloutSummaries(root: string, records: Stage1Record[]): Promise<void> {
  const dir = path.join(root, ROLLOUT_SUMMARIES_DIR);
  await mkdir(dir, { recursive: true });

  for (const record of records) {
    const fileName = `${record.sessionId}.md`;
    const lines: string[] = [
      `session_id: ${record.sessionId}`,
      `updated_at: ${record.updatedAt}`,
      `workspace_root: ${record.workspaceRoot}`
    ];
    if (record.rolloutSlug) {
      lines.push(`rollout_slug: ${record.rolloutSlug}`);
    }
    lines.push("");
    lines.push(record.rolloutSummary.trim());
    await writeFile(path.join(dir, fileName), `${lines.join("\n")}\n`, "utf8");
  }
}

async function writeMemorySummary(
  root: string,
  records: Stage1Record[],
  config: EffectiveConfig
): Promise<void> {
  if (records.length === 0) {
    const content = "No consolidated memories yet.\n";
    await writeFile(path.join(root, MEMORY_SUMMARY_FILE), content, "utf8");
    await writeFile(path.join(root, MEMORY_CANONICAL_FILE), content, "utf8");
    return;
  }

  const providerConfig = config.providers[config.defaultProvider];
  if (!providerConfig?.authValue) {
    const fallback = buildFallbackSummary(records, config.memories.summaryMaxChars);
    await writeFile(path.join(root, MEMORY_SUMMARY_FILE), fallback, "utf8");
    await writeFile(path.join(root, MEMORY_CANONICAL_FILE), fallback, "utf8");
    return;
  }

  const client = createProviderClient(providerConfig);
  const model = config.memories.consolidationModel ?? config.defaultModel;
  const systemPrompt = [
    "You consolidate multiple raw memories into a concise memory summary for future prompts.",
    "Keep only durable facts, preferences, and project constraints.",
    "Output plain text (no JSON, no markdown fences)."
  ].join("\n");
  const userPrompt = buildConsolidationInput(records, config.memories.rawMemoryMaxChars);

  let summary = "";
  try {
    const response = await client.complete({
      model,
      messages: withSystemMessage(systemPrompt, [{ role: "user", content: userPrompt }]),
      temperature: 0.2
    });
    summary = response.content ?? "";
  } catch {
    summary = buildFallbackSummary(records, config.memories.summaryMaxChars);
  }

  summary = truncate(summary.trim(), config.memories.summaryMaxChars);
  if (!summary) {
    summary = buildFallbackSummary(records, config.memories.summaryMaxChars);
  }
  await writeFile(path.join(root, MEMORY_SUMMARY_FILE), `${summary}\n`, "utf8");
  await writeFile(path.join(root, MEMORY_CANONICAL_FILE), `${summary}\n`, "utf8");
}

function buildTranscript(session: SessionState, maxChars: number): string {
  const lines: string[] = [];
  for (const message of session.messages) {
    const content = message.content ?? "";
    if (!content.trim()) {
      continue;
    }
    lines.push(`${message.role.toUpperCase()}: ${content.trim()}`);
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolNames = message.tool_calls.map((call) => call.function.name).filter(Boolean).join(", ");
      if (toolNames) {
        lines.push(`TOOLS: ${toolNames}`);
      }
    }
    lines.push("");
  }
  const transcript = lines.join("\n").trim();
  return truncateMiddle(transcript, maxChars);
}

function buildConsolidationInput(records: Stage1Record[], rawLimit: number): string {
  const lines: string[] = ["Raw memories:"];
  for (const record of records) {
    lines.push(`- session ${record.sessionId} (${record.updatedAt})`);
    const raw = truncate(record.rawMemory.trim(), rawLimit);
    lines.push(raw ? raw : "(empty)");
    lines.push("");
  }
  return lines.join("\n");
}

function buildFallbackSummary(records: Stage1Record[], maxChars: number): string {
  const lines: string[] = ["Memory summary (fallback):"];
  for (const record of records) {
    lines.push(`- ${record.rolloutSummary.trim()}`);
  }
  return truncate(lines.join("\n"), maxChars) + "\n";
}

function parseMemoryJson(text: string): Record<string, any> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(1, Math.floor(maxChars * 0.6));
  const tail = Math.max(1, maxChars - head - 3);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function normalizeSlug(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = compact.replace(/^-+|-+$/g, "");
  return trimmed ? trimmed.slice(0, 60) : undefined;
}

async function loadState(root: string): Promise<MemoryState> {
  const empty: MemoryState = { stage1: {}, phase2: { lastSelection: [], lastRunAt: null } };
  const pathRef = path.join(root, STATE_FILE);
  try {
    const raw = await readFile(pathRef, "utf8");
    const parsed = JSON.parse(raw) as MemoryState;
    if (!parsed || typeof parsed !== "object") {
      return empty;
    }
    return {
      stage1: parsed.stage1 ?? {},
      phase2: parsed.phase2 ?? { lastSelection: [], lastRunAt: null }
    };
  } catch {
    return empty;
  }
}

async function saveState(root: string, state: MemoryState): Promise<void> {
  const pathRef = path.join(root, STATE_FILE);
  await writeFile(pathRef, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
