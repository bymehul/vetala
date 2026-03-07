import type { SkillCatalogEntry } from "../skills/types.js";

export interface SlashSuggestion {
  label: string;
  completion: string;
  detail: string;
}

interface RootCommand {
  name: string;
  detail: string;
  completion: string;
  aliases?: string[];
}

const ROOT_COMMANDS: RootCommand[] = [
  { name: "help", completion: "/help", detail: "Show known commands" },
  { name: "model", completion: "/model", detail: "Model, reasoning, and auth settings" },
  { name: "skill", completion: "/skill", detail: "List, pin, inspect, and read local skills", aliases: ["skills"] },
  { name: "tools", completion: "/tools", detail: "List available tools" },
  { name: "history", completion: "/history", detail: "Show recent message history" },
  { name: "resume", completion: "/resume ", detail: "Resume a prior session" },
  { name: "new", completion: "/new", detail: "Start a fresh session" },
  { name: "approve", completion: "/approve", detail: "Show active approvals" },
  { name: "config", completion: "/config", detail: "Show runtime config" },
  { name: "logout", completion: "/logout", detail: "Clear local auth state" },
  { name: "clear", completion: "/clear", detail: "Clear the visible transcript" },
  { name: "exit", completion: "/exit", detail: "Exit Vetala" }
];

export function buildSlashSuggestions(input: string, skills: SkillCatalogEntry[]): SlashSuggestion[] {
  if (!input.startsWith("/")) {
    return [];
  }

  const query = input.slice(1);

  if (query.length === 0) {
    return ROOT_COMMANDS.map(toRootSuggestion);
  }

  const firstWhitespace = query.search(/\s/);

  if (firstWhitespace === -1) {
    const prefix = query.toLowerCase();
    const rootMatches = ROOT_COMMANDS.filter((command) =>
      command.name.startsWith(prefix) || (command.aliases ?? []).some((alias) => alias.startsWith(prefix))
    );

    if (prefix === "skill" || prefix === "skills") {
      return uniqueByCompletion([...rootMatches.map(toRootSuggestion), ...skillBaseSuggestions(skills)]);
    }

    return rootMatches.map(toRootSuggestion);
  }

  const rawCommand = query.slice(0, firstWhitespace).toLowerCase();
  const remainder = query.slice(firstWhitespace + 1);
  const command = rawCommand === "skills" ? "skill" : rawCommand;

  if (command === "skill") {
    return buildSkillSuggestions(remainder, skills);
  }

  return ROOT_COMMANDS
    .filter((root) => root.name === command)
    .map(toRootSuggestion);
}

function buildSkillSuggestions(remainder: string, skills: SkillCatalogEntry[]): SlashSuggestion[] {
  const trimmedLeft = remainder.replace(/^\s+/, "");

  if (!trimmedLeft) {
    return skillBaseSuggestions(skills);
  }

  const firstSpace = trimmedLeft.search(/\s/);

  if (firstSpace === -1) {
    const prefix = trimmedLeft.toLowerCase();
    return skillSubcommands()
      .filter((suggestion) => suggestion.subcommand.startsWith(prefix))
      .map(({ subcommand, detail, completion }) => ({
        label: completionLabel(subcommand),
        completion,
        detail
      }));
  }

  const rawSubcommand = trimmedLeft.slice(0, firstSpace).toLowerCase();
  const remainderAfterSubcommand = trimmedLeft.slice(firstSpace + 1);

  switch (rawSubcommand) {
    case "use":
    case "pin":
    case "show":
    case "load":
    case "drop":
    case "unpin":
      return skillNameSuggestions(rawSubcommand, remainderAfterSubcommand, skills);
    case "read":
      return skillReadSuggestions(remainderAfterSubcommand, skills);
    default:
      return skillBaseSuggestions(skills);
  }
}

function skillBaseSuggestions(skills: SkillCatalogEntry[]): SlashSuggestion[] {
  const suggestions = skillSubcommands().map(({ subcommand, detail, completion }) => ({
    label: completionLabel(subcommand),
    completion,
    detail
  }));

  return [
    {
      label: "/skill",
      completion: "/skill",
      detail: "List all available local skills"
    },
    ...suggestions,
    ...skills.slice(0, 4).map((skill) => ({
      label: `/skill show ${skill.name}`,
      completion: `/skill show ${skill.name}`,
      detail: skill.description || "Show this skill"
    }))
  ];
}

function skillSubcommands(): Array<{ subcommand: string; completion: string; detail: string }> {
  return [
    { subcommand: "use", completion: "/skill use ", detail: "Pin a skill for future turns" },
    { subcommand: "show", completion: "/skill show ", detail: "Load a skill overview" },
    { subcommand: "read", completion: "/skill read ", detail: "Read a file inside a skill" },
    { subcommand: "drop", completion: "/skill drop ", detail: "Unpin a skill" },
    { subcommand: "clear", completion: "/skill clear", detail: "Clear all pinned skills" }
  ];
}

function skillNameSuggestions(
  subcommand: string,
  remainder: string,
  skills: SkillCatalogEntry[]
): SlashSuggestion[] {
  const prefix = remainder.trim().toLowerCase();
  const matches = skills.filter((skill) => skill.name.toLowerCase().startsWith(prefix));

  return matches.map((skill) => ({
    label: `/skill ${canonicalSkillSubcommand(subcommand)} ${skill.name}`,
    completion: `/skill ${canonicalSkillSubcommand(subcommand)} ${skill.name}`,
    detail: skill.description || `${canonicalSkillSubcommand(subcommand)} ${skill.name}`
  }));
}

function skillReadSuggestions(remainder: string, skills: SkillCatalogEntry[]): SlashSuggestion[] {
  const trimmedLeft = remainder.replace(/^\s+/, "");

  if (!trimmedLeft) {
    return skills.map((skill) => ({
      label: `/skill read ${skill.name}`,
      completion: `/skill read ${skill.name} `,
      detail: `Read files from ${skill.name}`
    }));
  }

  const firstSpace = trimmedLeft.search(/\s/);

  if (firstSpace === -1) {
    const prefix = trimmedLeft.toLowerCase();
    return skills
      .filter((skill) => skill.name.toLowerCase().startsWith(prefix))
      .map((skill) => ({
        label: `/skill read ${skill.name}`,
        completion: `/skill read ${skill.name} `,
        detail: `Read files from ${skill.name}`
      }));
  }

  const skillName = trimmedLeft.slice(0, firstSpace);
  const skill = skills.find((entry) => entry.name === skillName);

  if (!skill) {
    return [];
  }

  const pathPrefix = trimmedLeft.slice(firstSpace + 1).trim().toLowerCase();
  const files = skill.availableFiles.filter((file) => file.toLowerCase().startsWith(pathPrefix));

  return files.slice(0, 8).map((file) => ({
    label: `/skill read ${skill.name} ${file}`,
    completion: `/skill read ${skill.name} ${file}`,
    detail: `Read ${file}`
  }));
}

function toRootSuggestion(command: RootCommand): SlashSuggestion {
  return {
    label: `/${command.name}`,
    completion: command.completion,
    detail: command.detail
  };
}

function completionLabel(subcommand: string): string {
  return `/skill ${subcommand}`;
}

function canonicalSkillSubcommand(subcommand: string): string {
  switch (subcommand) {
    case "pin":
      return "use";
    case "load":
      return "show";
    case "unpin":
      return "drop";
    default:
      return subcommand;
  }
}

function uniqueByCompletion(suggestions: SlashSuggestion[]): SlashSuggestion[] {
  const seen = new Set<string>();
  const output: SlashSuggestion[] = [];

  for (const suggestion of suggestions) {
    if (seen.has(suggestion.completion)) {
      continue;
    }

    seen.add(suggestion.completion);
    output.push(suggestion);
  }

  return output;
}
