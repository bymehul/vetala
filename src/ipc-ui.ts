import { TerminalUI } from "./terminal-ui.js";
import { formatRuntimeHostSummary, formatRuntimeTerminalSummary } from "./runtime-profile.js";
import type { EffectiveConfig, RuntimeHostProfile, SessionState, ToolCall } from "./types.js";
import type { Ora } from "ora";

type IpcTag =
    | "ready" | "entry" | "chunk" | "flush"
    | "activity" | "spinner" | "status"
    | "prompt" | "clear";

type EntryKind = "user" | "assistant" | "tool" | "info" | "warn" | "error" | "activity";

function sendIPC(tag: IpcTag, data: Record<string, unknown> = {}): void {
    const msg = JSON.stringify({ tag, data });
    process.stdout.write(msg + "\n");
}

export class IpcTerminalUI extends TerminalUI {
    constructor(runtimeProfile: RuntimeHostProfile) {
        super(runtimeProfile);
    }

    /** Send the initial dashboard / ready message */
    sendReady(session: SessionState, isLoggedIn: boolean): void {
        sendIPC("ready", {
            provider: session.provider,
            model: session.model,
            workspace: session.workspaceRoot,
            sessionId: session.id,
            updatedAt: session.updatedAt,
            isLoggedIn
        });
    }


    override printBanner(): void { }

    override printStartup(_session: SessionState): void { }

    override printTrustPrompt(workspaceRoot: string): void {
        sendIPC("prompt", { promptType: "trust", workspace: workspaceRoot });
    }

    override promptLabel(): string {
        return "";
    }

    override info(message: string): void {
        sendIPC("entry", { kind: "info", text: message });
    }

    override activity(message: string): void {
        sendIPC("activity", { label: message });
    }

    override warn(message: string): void {
        sendIPC("entry", { kind: "warn", text: message });
    }

    override error(message: string): void {
        sendIPC("entry", { kind: "error", text: message });
    }

    sendEntry(kind: EntryKind, text: string): void {
        sendIPC("entry", { kind, text });
    }

    override startSpinner(label: string): Ora {
        sendIPC("spinner", { label, active: true });

        let spinning = true;
        const fakeSpinner = {
            get isSpinning() {
                return spinning;
            },
            stop() {
                spinning = false;
                sendIPC("spinner", { label: null, active: false });
                return fakeSpinner;
            }
        };

        return fakeSpinner as Ora;
    }

    override appendAssistantText(text: string): void {
        sendIPC("chunk", { text });
    }

    override printAssistantMessage(message: string): void {
        // Flush any streaming buffer first, then push a complete entry
        sendIPC("flush", {});
        sendIPC("entry", { kind: "assistant", text: message });
    }

    override finalizeAssistantMessage(message: string): void {
        if (!message) {
            return;
        }
        sendIPC("flush", {});
        sendIPC("entry", { kind: "assistant", text: message });
    }

    override endAssistantTurn(): void {
        sendIPC("flush", {});
    }

    override printToolCall(toolCall: ToolCall): void {
        let renderedArgs = "{}";
        try {
            const parsed = JSON.parse(toolCall.function.arguments);
            if (Object.keys(parsed).length > 0) {
                renderedArgs = JSON.stringify(parsed, null, 2);
            }
        } catch {
            renderedArgs = toolCall.function.arguments.trim() || "{}";
        }

        sendIPC("flush", {});
        sendIPC("entry", {
            kind: "tool",
            text: `⬢  ${toolCall.function.name}\n${renderedArgs}`
        });
    }

    override printToolResult(summary: string, isError: boolean): void {
        sendIPC("flush", {});
        sendIPC("entry", {
            kind: isError ? "error" : "tool",
            text: `↳  ${summary}`
        });
    }

    override printConfig(config: EffectiveConfig): void {
        sendIPC("entry", {
            kind: "info",
            text: [
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
            ].join("\n")
        });
    }


    sendApprovalPrompt(label: string): void {
        sendIPC("prompt", { promptType: "approval", label });
    }

    sendPromptSelect(id: string, title: string, options: string[]): void {
        sendIPC("prompt", { promptType: "select", id, title, options });
    }

    sendPromptInput(id: string, title: string, placeholder: string): void {
        sendIPC("prompt", { promptType: "input", id, title, placeholder });
    }

    sendStatus(text: string): void {
        sendIPC("status", { text });
    }

    sendClear(): void {
        sendIPC("clear", {});
    }

    async offloadDiff(before: string, after: string): Promise<string> {
        const id = Math.random().toString();
        return new Promise((resolve) => {
            const handler = (data: any) => {
                if (data.id === id) {
                    process.off("message", handler); // This won't work as we are using stdout/stdin pipes
                }
            };
            // I need a way to listen for responses in the backend. 
            // The rl.on("line") in ipc-backend.ts is the right place.
        });
    }
}
