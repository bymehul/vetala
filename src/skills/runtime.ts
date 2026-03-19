import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../session-store.js";
import type { SessionState } from "../types.js";
import type {
  ActiveSkillMatch,
  LoadedSkillSummary,
  ReadSkillFileResult,
  SkillCatalogEntry,
  SkillRoutingMetadata,
  SkillToolApi,
  TurnSkillContext
} from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_FILE_LIST = 24;
const MAX_LOAD_BODY_CHARS = 4_000;
const MAX_READ_CHARS = 12_000;
const MAX_HEADINGS = 8;
const MAX_LINKS = 12;
const MAX_PINNED_PROMPT_CHARS = 2_200;
const MAX_AUTO_APPLY_SKILLS = 2;
const MAX_TURN_PROMPT_CHARS = 2_600;
const ROUTING_SCORE_THRESHOLD = 18;

interface SkillRuntimeOptions {
  getSession: () => SessionState;
  sessionStore: SessionStore;
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  routing: SkillRoutingMetadata;
}

interface SkillRoutingInput {
  normalizedInput: string;
  inputTokens: Set<string>;
  pathCandidates: string[];
}

export class SkillRuntime implements SkillToolApi {
  private cachedRoot: string | null = null;
  private cachedSkills: SkillCatalogEntry[] = [];

  constructor(private readonly options: SkillRuntimeOptions) {}

  async listSkills(): Promise<SkillCatalogEntry[]> {
    return [...await this.ensureCatalog()];
  }

  async loadSkill(name: string): Promise<LoadedSkillSummary> {
    const skill = await this.requireSkill(name);
    const raw = await readFile(skill.entryPath, "utf8");
    const body = stripFrontmatter(raw).trim();
    const headings = extractHeadings(body);
    const linkedFiles = extractLinkedFiles(body);
    const excerpt = body.length > MAX_LOAD_BODY_CHARS
      ? `${body.slice(0, MAX_LOAD_BODY_CHARS - 3).trimEnd()}...`
      : body;

    const overviewLines = [
      `Skill: ${skill.name}`,
      `Description: ${skill.description || "(none)"}`,
      `Entry: ${skill.entryPath}`
    ];

    const routingSummary = formatRoutingSummary(skill.routing);
    if (routingSummary.length > 0) {
      overviewLines.push(...routingSummary);
    }

    if (headings.length > 0) {
      overviewLines.push(`Headings: ${headings.join(" | ")}`);
    }

    if (linkedFiles.length > 0) {
      overviewLines.push(`Linked files: ${linkedFiles.join(", ")}`);
    }

    if (skill.availableFiles.length > 0) {
      overviewLines.push(`Available files: ${formatList(skill.availableFiles, 8)}`);
    }

    if (excerpt) {
      overviewLines.push("", excerpt);
    }

    return {
      ...skill,
      headings,
      linkedFiles,
      overview: overviewLines.join("\n")
    };
  }

  async readSkillFile(name: string, relativePath = "SKILL.md"): Promise<ReadSkillFileResult> {
    const skill = await this.requireSkill(name);
    const targetPath = resolveSkillPath(skill.rootPath, relativePath);
    const buffer = await readFile(targetPath);

    if (buffer.includes(0)) {
      throw new Error(`Skill file is binary and cannot be read as text: ${relativePath}`);
    }

    const content = buffer.toString("utf8");
    return {
      path: targetPath,
      content: content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS - 3).trimEnd()}...`
        : content
    };
  }

  async pinSkill(name: string): Promise<SkillCatalogEntry> {
    const skill = await this.requireSkill(name);
    await this.options.sessionStore.pinSkill(this.options.getSession(), skill.name);
    return skill;
  }

  async unpinSkill(name: string): Promise<SkillCatalogEntry> {
    const skill = await this.requireSkill(name);
    await this.options.sessionStore.unpinSkill(this.options.getSession(), skill.name);
    return skill;
  }

  async clearPinnedSkills(): Promise<number> {
    const pinnedCount = this.options.getSession().pinnedSkills.length;
    await this.options.sessionStore.clearPinnedSkills(this.options.getSession());
    return pinnedCount;
  }

  async pinnedSkills(): Promise<SkillCatalogEntry[]> {
    const pinned = new Set(this.options.getSession().pinnedSkills);
    const catalog = await this.ensureCatalog();
    return catalog.filter((skill) => pinned.has(skill.name));
  }

  async resolveTurnContext(userInput: string): Promise<TurnSkillContext> {
    const session = this.options.getSession();
    const catalog = await this.ensureCatalog();
    const pinnedNames = new Set(session.pinnedSkills);
    const routingInput = buildRoutingInput(session, userInput);

    const pinned = session.pinnedSkills
      .map((name) => catalog.find((skill) => skill.name === name))
      .filter((skill): skill is SkillCatalogEntry => Boolean(skill))
      .map((skill) => ({
        ...skill,
        source: "pinned" as const,
        score: 10_000,
        reasons: ["pinned for this session"]
      }));

    const auto = catalog
      .filter((skill) => !pinnedNames.has(skill.name))
      .map((skill) => scoreSkillMatch(skill, routingInput))
      .filter((match): match is ActiveSkillMatch => Boolean(match))
      .sort(compareActiveSkillMatches)
      .slice(0, MAX_AUTO_APPLY_SKILLS);

    const active = [...pinned, ...auto];
    return {
      active,
      labels: active.map(formatActiveSkillLabel),
      prompt: await buildTurnSkillPrompt(active)
    };
  }

  async inventoryPrompt(): Promise<string> {
    const skills = await this.ensureCatalog();

    if (skills.length === 0) {
      return "No local skills are available in the skill/ directory.";
    }

    return [
      "Local skills are available through the skill tool. Use `skill` when a request matches one of these domains:",
      ...skills.map((skill) => `- ${skill.name}${skill.routing.autoApply ? " [auto]" : ""}: ${shorten(skill.description, 160)}`)
    ].join("\n");
  }

  async pinnedPrompt(): Promise<string | null> {
    const skills = await this.pinnedSkills();

    if (skills.length === 0) {
      return null;
    }

    const lines = ["Pinned skills remain active across context compaction:"];

    for (const skill of skills) {
      const loaded = await this.loadSkill(skill.name);
      lines.push(`- ${skill.name}: ${shorten(skill.description, 160)}`);

      if (loaded.headings.length > 0) {
        lines.push(`  sections: ${formatList(loaded.headings, 4)}`);
      }

      if (loaded.linkedFiles.length > 0) {
        lines.push(`  files: ${formatList(loaded.linkedFiles, 4)}`);
      }

      if (lines.join("\n").length > MAX_PINNED_PROMPT_CHARS) {
        break;
      }
    }

    return lines.join("\n");
  }

  private async ensureCatalog(): Promise<SkillCatalogEntry[]> {
    const root = await this.resolveSkillRoot();

    if (!root) {
      this.cachedRoot = null;
      this.cachedSkills = [];
      return this.cachedSkills;
    }

    if (this.cachedRoot === root) {
      return this.cachedSkills;
    }

    const entries = await readdir(root, { withFileTypes: true });
    const skills: SkillCatalogEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const skillRoot = path.join(root, entry.name);
      const entryPath = path.join(skillRoot, "SKILL.md");

      if (!await exists(entryPath)) {
        continue;
      }

      const raw = await readFile(entryPath, "utf8");
      const frontmatter = parseFrontmatter(raw);
      skills.push({
        name: frontmatter.name || entry.name,
        description: frontmatter.description || "",
        rootPath: skillRoot,
        entryPath,
        availableFiles: await listSkillFiles(skillRoot),
        routing: frontmatter.routing
      });
    }

    skills.sort((left, right) => left.name.localeCompare(right.name));
    this.cachedRoot = root;
    this.cachedSkills = skills;
    return this.cachedSkills;
  }

  private async requireSkill(name: string): Promise<SkillCatalogEntry> {
    const normalized = name.trim();

    if (!normalized) {
      throw new Error("Skill name is required.");
    }

    const skills = await this.ensureCatalog();
    const match = skills.find((skill) => skill.name === normalized);

    if (!match) {
      throw new Error(`Unknown skill: ${normalized}`);
    }

    return match;
  }

  private async resolveSkillRoot(): Promise<string | null> {
    const envRoot = process.env.VETALA_SKILL_ROOT?.trim() || process.env.TATTVA_SKILL_ROOT?.trim();

    if (envRoot) {
      return await existsDirectory(path.resolve(envRoot)) ? path.resolve(envRoot) : null;
    }

    const workspaceRoot = this.options.getSession().workspaceRoot;
    const workspaceSkillRoot = path.join(workspaceRoot, "skill");

    if (await existsDirectory(workspaceSkillRoot)) {
      return workspaceSkillRoot;
    }

    return findBundledSkillRoot();
  }
}

async function listSkillFiles(skillRoot: string): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(skillRoot, skillRoot, files);
  files.sort((left, right) => left.localeCompare(right));
  return files.slice(0, MAX_FILE_LIST);
}

async function walkFiles(root: string, current: string, output: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const target = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await walkFiles(root, target, output);
      continue;
    }

    output.push(path.relative(root, target).split(path.sep).join("/"));
  }
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(FRONTMATTER_RE);

  if (!match) {
    return { name: "", description: "", routing: defaultSkillRoutingMetadata() };
  }

  const scalarValues = new Map<string, string>();
  const listValues = new Map<string, string[]>();
  let currentKey: string | null = null;
  let currentMode: "scalar" | "list" | null = null;

  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);

    if (kv) {
      const [, key = "", rawValue = ""] = kv;
      currentKey = normalizeFrontmatterKey(key);

      if (!currentKey) {
        continue;
      }

      const trimmedValue = rawValue.trim();
      if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
        listValues.set(currentKey, parseInlineList(trimmedValue));
        currentMode = null;
      } else {
        scalarValues.set(currentKey, stripQuotes(trimmedValue));
        currentMode = "scalar";
      }
      continue;
    }

    if (currentKey && /^\s*-\s+/.test(line)) {
      const items = listValues.get(currentKey) ?? [];
      items.push(stripQuotes(line.replace(/^\s*-\s+/, "").trim()));
      listValues.set(currentKey, items);
      currentMode = "list";
      scalarValues.delete(currentKey);
      continue;
    }

    if (currentKey && /^\s+/.test(line)) {
      if (currentMode === "list") {
        const items = listValues.get(currentKey) ?? [];
        if (items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${stripQuotes(line.trim())}`.trim();
          listValues.set(currentKey, items);
        }
        continue;
      }

      const currentValue = scalarValues.get(currentKey) ?? "";
      const nextPart = stripQuotes(line.trim());
      scalarValues.set(currentKey, currentValue ? `${currentValue} ${nextPart}` : nextPart);
      currentMode = "scalar";
      continue;
    }

    currentKey = null;
    currentMode = null;
  }

  return {
    name: scalarValues.get("name") ?? "",
    description: scalarValues.get("description") ?? "",
    routing: {
      keywords: normalizeStringList(listValues.get("keywords")),
      taskTypes: normalizeStringList(listValues.get("task_types")),
      pathGlobs: normalizeStringList(listValues.get("path_globs")),
      priority: parsePriority(scalarValues.get("priority")),
      autoApply: parseBoolean(scalarValues.get("auto_apply"))
    }
  };
}

function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "");
}

function extractHeadings(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^##+\s+(.*)$/)?.[1]?.trim() ?? null)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_HEADINGS);
}

function extractLinkedFiles(body: string): string[] {
  const links = new Set<string>();
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(body)) !== null) {
    const target = match[1]?.trim();

    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
      continue;
    }

    links.add(target);

    if (links.size >= MAX_LINKS) {
      break;
    }
  }

  return [...links];
}

function resolveSkillPath(skillRoot: string, relativePath: string): string {
  const normalized = relativePath.trim() || "SKILL.md";

  if (path.isAbsolute(normalized)) {
    throw new Error("Skill paths must be relative to the skill root.");
  }

  const resolved = path.resolve(skillRoot, normalized);
  const rootWithSep = skillRoot.endsWith(path.sep) ? skillRoot : `${skillRoot}${path.sep}`;

  if (resolved !== skillRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Skill path escapes the skill root: ${relativePath}`);
  }

  return resolved;
}

async function findBundledSkillRoot(): Promise<string | null> {
  let current = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = path.join(current, "skill");

    if (await existsDirectory(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function existsDirectory(targetPath: string): Promise<boolean> {
  try {
    const entries = await readdir(targetPath);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

function shorten(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();

  if (!compact) {
    return "(no description)";
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatList(values: string[], limit: number): string {
  const visible = values.slice(0, limit);
  const extra = values.length - visible.length;
  return `${visible.join(", ")}${extra > 0 ? `, and ${extra} more` : ""}`;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function normalizeFrontmatterKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

function parseInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((entry) => stripQuotes(entry.trim()))
    .filter(Boolean);
}

function parsePriority(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "true" || value === "yes" || value === "1";
}

function normalizeStringList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function defaultSkillRoutingMetadata(): SkillRoutingMetadata {
  return {
    keywords: [],
    taskTypes: [],
    pathGlobs: [],
    priority: 0,
    autoApply: false
  };
}

function formatRoutingSummary(routing: SkillRoutingMetadata): string[] {
  const lines: string[] = [];
  lines.push(`Auto apply: ${routing.autoApply ? "yes" : "no"}`);
  if (routing.priority !== 0) {
    lines.push(`Priority: ${routing.priority}`);
  }
  if (routing.keywords.length > 0) {
    lines.push(`Keywords: ${routing.keywords.join(", ")}`);
  }
  if (routing.taskTypes.length > 0) {
    lines.push(`Task types: ${routing.taskTypes.join(", ")}`);
  }
  if (routing.pathGlobs.length > 0) {
    lines.push(`Path globs: ${routing.pathGlobs.join(", ")}`);
  }
  return lines;
}

function buildRoutingInput(session: SessionState, userInput: string): SkillRoutingInput {
  const normalizedInput = normalizeForMatch(userInput);
  const inputTokens = new Set(tokenizeForMatch(userInput));
  const historyPaths = [...session.readFiles, ...session.referencedFiles]
    .slice(-16)
    .map((value) => toForwardSlashes(path.relative(session.workspaceRoot, value)))
    .filter((value) => value !== "" && value !== "." && !value.startsWith(".."));
  const inputPaths = extractInputPathCandidates(userInput);
  return {
    normalizedInput,
    inputTokens,
    pathCandidates: dedupeStrings([...inputPaths, ...historyPaths])
  };
}

function scoreSkillMatch(skill: SkillCatalogEntry, input: SkillRoutingInput): ActiveSkillMatch | null {
  const reasons: string[] = [];
  let score = 0;

  const explicitMention = mentionsSkillByName(input.normalizedInput, skill.name);
  if (explicitMention) {
    reasons.push(`mentioned by name (${skill.name})`);
    score += 100;
  }

  const keywordHits = countPhraseMatches(skill.routing.keywords, input.normalizedInput);
  if (keywordHits.length > 0) {
    reasons.push(`keyword: ${keywordHits[0]}`);
    score += 24 + Math.max(0, keywordHits.length-1)*8;
  }

  const taskTypeHits = countTaggedMatches(skill.routing.taskTypes, input.normalizedInput, input.inputTokens);
  if (taskTypeHits.length > 0) {
    reasons.push(`task: ${taskTypeHits[0]}`);
    score += 18 + Math.max(0, taskTypeHits.length-1)*6;
  }

  const pathHits = countPathMatches(skill.routing.pathGlobs, input.pathCandidates);
  if (pathHits.length > 0) {
    reasons.push(`path: ${pathHits[0]}`);
    score += 10 + Math.max(0, pathHits.length-1)*4;
  }

  if (!explicitMention && !skill.routing.autoApply) {
    return null;
  }

  score += skill.routing.priority * 2;
  if (!explicitMention && score < ROUTING_SCORE_THRESHOLD) {
    return null;
  }

  return {
    ...skill,
    source: "auto",
    score,
    reasons
  };
}

function compareActiveSkillMatches(left: ActiveSkillMatch, right: ActiveSkillMatch): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.routing.priority !== left.routing.priority) {
    return right.routing.priority - left.routing.priority;
  }
  return left.name.localeCompare(right.name);
}

async function buildTurnSkillPrompt(matches: ActiveSkillMatch[]): Promise<string | null> {
  if (matches.length === 0) {
    return null;
  }

  const lines = ["Apply these local skills when they are relevant to the user's request:"];

  for (const match of matches) {
    lines.push(`- ${match.name} [${match.source}] - ${shorten(match.description, 180)}`);
    if (match.reasons.length > 0) {
      lines.push(`  why active: ${match.reasons.slice(0, 2).join("; ")}`);
    }
    if (match.routing.keywords.length > 0) {
      lines.push(`  keywords: ${formatList(match.routing.keywords, 4)}`);
    }
    if (match.routing.taskTypes.length > 0) {
      lines.push(`  task types: ${formatList(match.routing.taskTypes, 4)}`);
    }
    if (match.routing.pathGlobs.length > 0) {
      lines.push(`  path globs: ${formatList(match.routing.pathGlobs, 4)}`);
    }

    const raw = await readFile(match.entryPath, "utf8");
    const body = stripFrontmatter(raw).trim();
    const headings = extractHeadings(body);
    const linkedFiles = extractLinkedFiles(body);
    if (headings.length > 0) {
      lines.push(`  sections: ${formatList(headings, 4)}`);
    }
    if (linkedFiles.length > 0) {
      lines.push(`  files: ${formatList(linkedFiles, 4)}`);
    }

    if (lines.join("\n").length > MAX_TURN_PROMPT_CHARS) {
      break;
    }
  }

  return lines.join("\n");
}

function formatActiveSkillLabel(match: ActiveSkillMatch): string {
  return `${match.name} (${match.source})`;
}

function normalizeForMatch(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function tokenizeForMatch(value: string): string[] {
  return dedupeStrings(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function mentionsSkillByName(normalizedInput: string, skillName: string): boolean {
  const normalizedName = normalizeForMatch(skillName).trim();
  if (!normalizedName) {
    return false;
  }
  return normalizedInput.includes(` ${normalizedName} `) || normalizedInput.includes(` $${normalizedName} `);
}

function countPhraseMatches(phrases: string[], normalizedInput: string): string[] {
  return phrases.filter((phrase) => {
    const normalizedPhrase = normalizeForMatch(phrase).trim();
    return normalizedPhrase.length > 0 && normalizedInput.includes(` ${normalizedPhrase} `);
  });
}

function countTaggedMatches(tags: string[], normalizedInput: string, inputTokens: Set<string>): string[] {
  return tags.filter((tag) => {
    const normalizedTag = normalizeForMatch(tag).trim();
    if (!normalizedTag) {
      return false;
    }
    if (normalizedInput.includes(` ${normalizedTag} `)) {
      return true;
    }
    const tagTokens = tokenizeForMatch(tag);
    return tagTokens.length > 0 && tagTokens.every((token) => inputTokens.has(token));
  });
}

function countPathMatches(globs: string[], candidates: string[]): string[] {
  if (globs.length === 0 || candidates.length === 0) {
    return [];
  }
  return globs.filter((glob) => candidates.some((candidate) => matchesGlob(candidate, glob)));
}

function matchesGlob(filePath: string, glob: string): boolean {
  const normalized = toForwardSlashes(filePath);
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "___DSTAR_SLASH___")
    .replace(/\/\*\*/g, "___SLASH_DSTAR___")
    .replace(/\*\*/g, "___DSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DSTAR_SLASH___/g, "(.*\\/)?")
    .replace(/___SLASH_DSTAR___/g, "(\\/.*)?")
    .replace(/___DSTAR___/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalized) || new RegExp(`/${escaped}$`).test(normalized);
}

function extractInputPathCandidates(value: string): string[] {
  const matches = value.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g) ?? [];
  return dedupeStrings(matches.map(toForwardSlashes));
}

function toForwardSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
