import type { SkillRuntime } from "../skills/runtime.js";
import { createFilesystemTools } from "./filesystem.js";
import { createGitTools } from "./git.js";
import { ToolRegistry } from "./registry.js";
import { createShellTools } from "./shell.js";
import { createSkillTools } from "./skill.js";
import { createWebToolsForConfig } from "./web.js";

export function createToolRegistry(options: {
  includeWebSearch?: boolean;
  skillRuntime?: SkillRuntime;
} = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const includeWebSearch = options.includeWebSearch ?? true;

  for (const tool of [
    ...createFilesystemTools(),
    ...createShellTools(),
    ...createGitTools(),
    ...(options.skillRuntime ? createSkillTools(options.skillRuntime) : []),
    ...createWebToolsForConfig(includeWebSearch)
  ]) {
    registry.register(tool);
  }

  return registry;
}
