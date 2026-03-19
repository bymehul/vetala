export interface SkillRoutingMetadata {
  keywords: string[];
  taskTypes: string[];
  pathGlobs: string[];
  priority: number;
  autoApply: boolean;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  rootPath: string;
  entryPath: string;
  availableFiles: string[];
  routing: SkillRoutingMetadata;
}

export interface LoadedSkillSummary extends SkillCatalogEntry {
  headings: string[];
  linkedFiles: string[];
  overview: string;
}

export interface ActiveSkillMatch extends SkillCatalogEntry {
  source: "pinned" | "auto";
  score: number;
  reasons: string[];
}

export interface TurnSkillContext {
  active: ActiveSkillMatch[];
  prompt: string | null;
  labels: string[];
}

export interface ReadSkillFileResult {
  path: string;
  content: string;
}

export interface SkillToolApi {
  listSkills(): Promise<SkillCatalogEntry[]>;
  loadSkill(name: string): Promise<LoadedSkillSummary>;
  readSkillFile(name: string, relativePath?: string): Promise<ReadSkillFileResult>;
  pinSkill(name: string): Promise<SkillCatalogEntry>;
  unpinSkill(name: string): Promise<SkillCatalogEntry>;
  clearPinnedSkills(): Promise<number>;
  pinnedSkills(): Promise<SkillCatalogEntry[]>;
  resolveTurnContext(userInput: string): Promise<TurnSkillContext>;
}
