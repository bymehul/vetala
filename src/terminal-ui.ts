import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import gradient from "gradient-string";
import ora, { Ora } from "ora";
import { APP_NAME, APP_TAGLINE, APP_VERSION } from "./app-meta.js";
import { formatRuntimeHostSummary, formatRuntimeTerminalSummary } from "./runtime-profile.js";
import type { EffectiveConfig, RuntimeHostProfile, SessionState, ToolCall } from "./types.js";

const BORDER = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│"
};

export class TerminalUI {
  private assistantLineOpen = false;

  constructor(protected readonly runtimeProfile: RuntimeHostProfile) {}

  printBanner(): void {
    this.endAssistantTurn();
    console.log(
      gradient(["#5d7285", "#91a4b5"])(APP_NAME) + chalk.dim(`  ${APP_TAGLINE}`)
    );
  }

  printStartup(session: SessionState): void {
    this.endAssistantTurn();
    console.clear();
    this.printBanner();
    console.log();
    console.log(
      this.renderSplitPanel(
        `${APP_NAME} ${chalk.dim(`(${APP_VERSION})`)}`,
        [
          chalk.bold("Welcome back!"),
          "",
          `provider:  ${session.provider}`,
          `model:     ${session.model}`,
          `directory: ${session.workspaceRoot}`,
          `session:   ${session.id.slice(0, 8)}`,
          `updated:   ${this.formatTimestamp(session.updatedAt)}`
        ],
        [
          chalk.bold("Tips"),
          "/help for commands",
          "/model to change model + reasoning",
          "/skill to inspect local skills",
          "/resume to reopen a session",
          "",
          chalk.bold("Recent activity"),
          ...this.recentActivity(session)
        ]
      )
    );
    console.log();
    console.log(
      this.renderPanel("Prompt", [
        'Try "explain this codebase" or "write a test for <filepath>"'
      ])
    );
    console.log(chalk.dim("Tip: type /help for commands. Safety and trust prompts appear inline."));
  }

  printTrustPrompt(workspaceRoot: string): void {
    this.endAssistantTurn();
    console.clear();
    this.printBanner();
    console.log();
    console.log(
      this.renderPanel("Accessing workspace", [
        workspaceRoot,
        "",
        "Quick safety check: Is this a project you created or one you trust? If not, review the folder before continuing.",
        "",
        "Vetala will be able to read, edit, and execute files here.",
        "",
        "> 1. Yes, I trust this folder",
        "  2. No, exit",
        "",
        "Press Enter to confirm option 1, or type 2 to exit."
      ])
    );
  }

  promptLabel(): string {
    return chalk.bold("\n› ");
  }

  info(message: string): void {
    this.endAssistantTurn();
    console.log(chalk.blue(message));
  }

  activity(message: string): void {
    this.endAssistantTurn();
    console.log(chalk.dim(message));
  }

  warn(message: string): void {
    this.endAssistantTurn();
    console.log(chalk.yellow(message));
  }

  error(message: string): void {
    this.endAssistantTurn();
    console.error(chalk.red(message));
  }

  startSpinner(label: string): Ora {
    this.endAssistantTurn();
    return ora({ text: label }).start();
  }

  appendAssistantText(text: string): void {
    if (!this.assistantLineOpen) {
      process.stdout.write(`${chalk.cyan("assistant")} ${chalk.dim("│")} `);
      this.assistantLineOpen = true;
    }

    process.stdout.write(text);
  }

  printAssistantMessage(message: string): void {
    this.endAssistantTurn();
    console.log(`${chalk.cyan("assistant")} ${chalk.dim("│")} ${message}`);
  }

  endAssistantTurn(): void {
    if (!this.assistantLineOpen) {
      return;
    }

    process.stdout.write("\n");
    this.assistantLineOpen = false;
  }

  printToolCall(toolCall: ToolCall): void {
    this.endAssistantTurn();
    const rawArgs = toolCall.function.arguments.trim();
    const renderedArgs = rawArgs ? rawArgs : "{}";
    console.log(`${chalk.magenta("tool")} ${chalk.dim("│")} ${toolCall.function.name} ${chalk.dim(renderedArgs)}`);
  }

  printToolResult(summary: string, isError: boolean): void {
    this.endAssistantTurn();
    const prefix = isError ? chalk.red("tool") : chalk.green("tool");
    console.log(`${prefix} ${chalk.dim("│")} ${summary}`);
  }

  printConfig(config: EffectiveConfig): void {
    this.endAssistantTurn();
    console.log(
      this.renderPanel("Config", [
        `config:  ${config.configPath}`,
        `data:    ${config.dataPath}`,
        `provider: ${config.defaultProvider}`,
        `auth:    ${config.authMode} (${config.authSource})`,
        `sha256:  ${config.authFingerprint?.slice(0, 12) ?? "(none)"}`,
        `model:   ${config.defaultModel}`,
        `reason:  ${config.reasoningEffort ?? "(none)"}`,
        `search:  ${config.searchProviderName}`,
        `base:    ${config.baseUrl}`,
        `memory:  recent=${config.memory.recentMessageCount}, events=${config.memory.maxMemoryEvents}, preview=${config.memory.maxPreviewLength}, refs=${config.memory.maxReferencedFiles}`,
        `context: files=${config.contextFiles.maxFiles}, fileBytes=${config.contextFiles.maxFileBytes}, totalBytes=${config.contextFiles.maxTotalBytes}`,
        `history: ${config.history.persistence}${config.history.maxBytes ? ` (${config.history.maxBytes} bytes)` : ""}`,
        `memories: enabled=${config.memories.enabled}, use=${config.memories.useMemories}, maxRollouts=${config.memories.maxRolloutsPerStartup}`,
        `host:    ${formatRuntimeHostSummary(this.runtimeProfile)}`,
        `term:    ${formatRuntimeTerminalSummary(this.runtimeProfile)}`
      ])
    );
  }

  private renderPanel(title: string, lines: string[]): string {
    const width = this.panelWidth();
    const innerWidth = Math.max(24, width - 4);
    const output = [
      this.renderTopBorder(title, width)
    ];

    for (const line of this.expandLines(lines, innerWidth)) {
      output.push(`${BORDER.vertical} ${this.padAnsi(line, innerWidth)} ${BORDER.vertical}`);
    }

    output.push(`${BORDER.bottomLeft}${BORDER.horizontal.repeat(width - 2)}${BORDER.bottomRight}`);
    return output.join("\n");
  }

  private renderSplitPanel(title: string, leftLines: string[], rightLines: string[]): string {
    const width = this.panelWidth();
    const available = Math.max(40, width - 8);
    const leftWidth = Math.max(22, Math.floor(available * 0.56));
    const rightWidth = Math.max(16, available - leftWidth);
    const left = this.expandLines(leftLines, leftWidth);
    const right = this.expandLines(rightLines, rightWidth);
    const rows = Math.max(left.length, right.length);
    const output = [this.renderTopBorder(title, width)];

    for (let index = 0; index < rows; index += 1) {
      output.push(
        `${BORDER.vertical} ${this.padAnsi(left[index] ?? "", leftWidth)} ${BORDER.vertical} ${this.padAnsi(right[index] ?? "", rightWidth)} ${BORDER.vertical}`
      );
    }

    output.push(`${BORDER.bottomLeft}${BORDER.horizontal.repeat(width - 2)}${BORDER.bottomRight}`);
    return output.join("\n");
  }

  private renderTopBorder(title: string, width: number): string {
    const plainTitle = ` ${stripVTControlCharacters(title)} `;
    const titlePadding = Math.max(0, width - 2 - plainTitle.length);
    return `${BORDER.topLeft}${BORDER.horizontal}${title}${BORDER.horizontal.repeat(
      Math.max(1, titlePadding - 1)
    )}${BORDER.topRight}`;
  }

  private panelWidth(): number {
    const columns = process.stdout.columns ?? 100;
    return Math.max(60, Math.min(columns - 2, 112));
  }

  private expandLines(lines: string[], width: number): string[] {
    const expanded: string[] = [];

    for (const line of lines) {
      if (line.length === 0) {
        expanded.push("");
        continue;
      }

      if (this.visibleWidth(line) <= width) {
        expanded.push(line);
        continue;
      }

      const plain = stripVTControlCharacters(line);
      expanded.push(...wrapPlain(plain, width));
    }

    return expanded;
  }

  private padAnsi(text: string, width: number): string {
    const visible = this.visibleWidth(text);
    return text + " ".repeat(Math.max(0, width - visible));
  }

  private visibleWidth(text: string): number {
    return stripVTControlCharacters(text).length;
  }

  private recentActivity(session: SessionState): string[] {
    const lines = session.messages
      .filter((message) => message.role !== "tool")
      .slice(-3)
      .map((message) => {
        const role = message.role.padEnd(9, " ");
        const content = (message.content ?? "[tool call]").replace(/\s+/g, " ").slice(0, 38);
        return `${role} ${content}`;
      });

    return lines.length > 0 ? lines : ["No recent activity"];
  }

  private formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
  }
}

function wrapPlain(text: string, width: number): string[] {
  if (text.length <= width) {
    return [text];
  }

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }

      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }

      continue;
    }

    const next = current ? `${current} ${word}` : word;

    if (next.length > width) {
      lines.push(current);
      current = word;
      continue;
    }

    current = next;
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}
