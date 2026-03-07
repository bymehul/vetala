import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../session-store.js";
import type { SessionState } from "../types.js";
import type { LoadedSkillSummary, ReadSkillFileResult, SkillCatalogEntry, SkillToolApi } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_FILE_LIST = 24;
const MAX_LOAD_BODY_CHARS = 4_000;
const MAX_READ_CHARS = 12_000;
const MAX_HEADINGS = 8;
const MAX_LINKS = 12;
const MAX_PINNED_PROMPT_CHARS = 2_200;

interface SkillRuntimeOptions {
  getSession: () => SessionState;
  sessionStore: SessionStore;
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

  async inventoryPrompt(): Promise<string> {
    const skills = await this.ensureCatalog();

    if (skills.length === 0) {
      return "No local skills are available in the skill/ directory.";
    }

    return [
      "Local skills are available through the skill tool. Use `skill` when a request matches one of these domains:",
      ...skills.map((skill) => `- ${skill.name}: ${shorten(skill.description, 160)}`)
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
        availableFiles: await listSkillFiles(skillRoot)
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

function parseFrontmatter(raw: string): { name: string; description: string } {
  const match = raw.match(FRONTMATTER_RE);

  if (!match) {
    return { name: "", description: "" };
  }

  const values = new Map<string, string>();
  let currentKey: string | null = null;

  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

    if (kv) {
      const [, key = "", rawValue = ""] = kv;
      currentKey = key || null;

      if (!currentKey) {
        continue;
      }

      values.set(currentKey, stripQuotes(rawValue.trim()));
      continue;
    }

    if (currentKey && /^\s+/.test(line)) {
      const currentValue = values.get(currentKey) ?? "";
      const nextPart = stripQuotes(line.trim());
      values.set(currentKey, currentValue ? `${currentValue} ${nextPart}` : nextPart);
      continue;
    }

    currentKey = null;
  }

  return {
    name: values.get("name") ?? "",
    description: values.get("description") ?? ""
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
