export interface SkillCatalogEntry {
  name: string;
  description: string;
  rootPath: string;
  entryPath: string;
  availableFiles: string[];
}

export interface LoadedSkillSummary extends SkillCatalogEntry {
  headings: string[];
  linkedFiles: string[];
  overview: string;
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
}
