import type { SkillRuntime } from "../skills/runtime.js";
import type { ToolResult, ToolSpec } from "../types.js";

export function createSkillTools(skillRuntime: SkillRuntime): ToolSpec[] {
  return [
    {
      name: "skill",
      description:
        "Inspect and manage local skills from the skill/ directory. Use this to list available skills, load a skill overview, read files within a skill, and pin or unpin skills for later turns.",
      jsonSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "load", "read", "pin", "unpin", "clear"],
            description: "The skill action to perform."
          },
          name: {
            type: "string",
            description: "Skill name. Required for load, read, pin, and unpin."
          },
          path: {
            type: "string",
            description: "Relative file path inside the skill root. Optional for read and defaults to SKILL.md."
          }
        },
        required: ["action"],
        additionalProperties: false
      },
      readOnly: false,
      async execute(rawArgs) {
        const args = expectObject(rawArgs);
        const action = requiredString(args.action, "action");

        try {
          switch (action) {
            case "list":
              return renderList(await skillRuntime.listSkills(), await skillRuntime.pinnedSkills());
            case "load": {
              const skill = await skillRuntime.loadSkill(requiredString(args.name, "name"));
              return {
                summary: `Loaded skill ${skill.name}`,
                content: skill.overview,
                isError: false,
                referencedFiles: [skill.entryPath],
                readFiles: [skill.entryPath]
              };
            }
            case "read": {
              const skillName = requiredString(args.name, "name");
              const pathArg = typeof args.path === "string" ? args.path : "SKILL.md";
              const file = await skillRuntime.readSkillFile(skillName, pathArg);
              return {
                summary: `Read ${pathArg} from ${skillName}`,
                content: file.content,
                isError: false,
                referencedFiles: [file.path],
                readFiles: [file.path]
              };
            }
            case "pin": {
              const skill = await skillRuntime.pinSkill(requiredString(args.name, "name"));
              return {
                summary: `Pinned skill ${skill.name}`,
                content: `Pinned ${skill.name} for future turns.`,
                isError: false,
                referencedFiles: [skill.entryPath]
              };
            }
            case "unpin": {
              const skill = await skillRuntime.unpinSkill(requiredString(args.name, "name"));
              return {
                summary: `Unpinned skill ${skill.name}`,
                content: `Removed ${skill.name} from pinned skills.`,
                isError: false,
                referencedFiles: [skill.entryPath]
              };
            }
            case "clear": {
              const cleared = await skillRuntime.clearPinnedSkills();
              return {
                summary: cleared > 0 ? `Cleared ${cleared} pinned skills` : "No pinned skills to clear",
                content: cleared > 0 ? `Cleared ${cleared} pinned skills.` : "No pinned skills were active.",
                isError: false
              };
            }
            default:
              return invalidAction(action);
          }
        } catch (error) {
          return {
            summary: `Skill action failed: ${action}`,
            content: error instanceof Error ? error.message : String(error),
            isError: true
          };
        }
      }
    }
  ];
}

function renderList(
  skills: Awaited<ReturnType<SkillRuntime["listSkills"]>>,
  pinned: Awaited<ReturnType<SkillRuntime["pinnedSkills"]>>
): ToolResult {
  const pinnedNames = new Set(pinned.map((skill) => skill.name));
  const content = skills.length > 0
    ? skills
        .map((skill) => {
          const marker = pinnedNames.has(skill.name) ? "*" : "-";
          const mode = skill.routing.autoApply ? "[auto]" : "[manual]";
          return `${marker} ${skill.name} ${mode} - ${skill.description || "(no description)"}`;
        })
        .join("\n")
    : "(no skills available)";

  return {
    summary: `Listed ${skills.length} skills`,
    content,
    isError: false,
    referencedFiles: skills.map((skill) => skill.entryPath)
  };
}

function invalidAction(action: string): ToolResult {
  return {
    summary: `Unknown skill action: ${action}`,
    content: `Unknown skill action: ${action}. Use list, load, read, pin, unpin, or clear.`,
    isError: true
  };
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool arguments must be a JSON object.");
}

function requiredString(value: unknown, key: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`Missing string argument: ${key}`);
}
