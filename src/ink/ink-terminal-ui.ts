import type { Ora } from "ora";
import { TerminalUI } from "../terminal-ui.js";
import type { EffectiveConfig, SessionState, ToolCall } from "../types.js";

export type InkEntryKind = "assistant" | "user" | "tool" | "info" | "warn" | "error" | "activity";

export interface InkUiEntry {
  id: string;
  kind: InkEntryKind;
  text: string;
}

interface InkUiBridge {
  appendAssistant(text: string): void;
  finalizeAssistant(): void;
  pushEntry(kind: InkEntryKind, text: string): void;
  setActivity(label: string | null): void;
  setSpinner(label: string | null): void;
}

export class InkTerminalUI extends TerminalUI {
  constructor(private readonly bridge: InkUiBridge) {
    super();
  }

  override printBanner(): void {}

  override printStartup(_session: SessionState): void {}

  override printTrustPrompt(_workspaceRoot: string): void {}

  override promptLabel(): string {
    return "";
  }

  override info(message: string): void {
    this.bridge.pushEntry("info", message);
  }

  override activity(message: string): void {
    this.bridge.setActivity(message);
  }

  override warn(message: string): void {
    this.bridge.pushEntry("warn", message);
  }

  override error(message: string): void {
    this.bridge.pushEntry("error", message);
  }

  override startSpinner(label: string): Ora {
    let spinning = true;
    this.bridge.setSpinner(label);

    const fakeSpinner = {
      get isSpinning() {
        return spinning;
      },
      stop() {
        spinning = false;
        return fakeSpinner;
      }
    };

    const originalStop = fakeSpinner.stop.bind(fakeSpinner);
    fakeSpinner.stop = () => {
      const result = originalStop();
      this.bridge.setSpinner(null);
      return result;
    };

    return fakeSpinner as Ora;
  }

  override appendAssistantText(text: string): void {
    this.bridge.appendAssistant(text);
  }

  override printAssistantMessage(message: string): void {
    this.bridge.finalizeAssistant();
    this.bridge.pushEntry("assistant", message);
  }

  override endAssistantTurn(): void {
    this.bridge.finalizeAssistant();
  }

  override printToolCall(toolCall: ToolCall): void {
    const rawArgs = toolCall.function.arguments.trim();
    const renderedArgs = rawArgs ? rawArgs : "{}";
    this.bridge.finalizeAssistant();
    this.bridge.pushEntry("tool", `${toolCall.function.name} ${renderedArgs}`);
  }

  override printToolResult(summary: string, isError: boolean): void {
    this.bridge.finalizeAssistant();
    this.bridge.pushEntry(isError ? "error" : "tool", summary);
  }

  override printConfig(config: EffectiveConfig): void {
    this.bridge.pushEntry(
      "info",
      [
        `config:  ${config.configPath}`,
        `data:    ${config.dataPath}`,
        `auth:    ${config.authMode} (${config.authSource})`,
        `sha256:  ${config.authFingerprint?.slice(0, 12) ?? "(none)"}`,
        `model:   ${config.defaultModel}`,
        `reason:  ${config.reasoningEffort ?? "(none)"}`,
        `search:  ${config.searchProviderName}`,
        `base:    ${config.baseUrl}`
      ].join("\n")
    );
  }
}
