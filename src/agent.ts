import { ApprovalManager } from "./approvals.js";
import { compactConversation } from "./context-memory.js";
import { loadMemoriesPrompt, loadRulesPrompt } from "./context-files.js";
import { appendHistoryEntry } from "./history-store.js";
import { PathPolicy } from "./path-policy.js";
import { createProviderClient, getProviderDefinition, providerLabel, withSystemMessage } from "./providers/index.js";
import { createSearchProvider } from "./search-provider.js";
import { SessionStore } from "./session-store.js";
import { TerminalUI } from "./terminal-ui.js";
import { ToolRegistry } from "./tools/registry.js";
import type { ChatProviderClient, ProviderRequestOptions } from "./providers/index.js";
import type { SkillRuntime } from "./skills/runtime.js";
import type {
  ChatMessage,
  EffectiveConfig,
  PersistedMessage,
  RuntimeHostProfile,
  SessionState,
  StreamedAssistantTurn,
  ToolContext
} from "./types.js";

export interface AgentOptions {
  config: EffectiveConfig;
  session: SessionState;
  sessionStore: SessionStore;
  approvals: ApprovalManager;
  pathPolicy: PathPolicy;
  runtimeProfile: RuntimeHostProfile;
  skills: SkillRuntime;
  tools: ToolRegistry;
  ui: TerminalUI;
  requestTextInput: (title: string, placeholder: string) => Promise<string>;
  requestSelect: (title: string, options: string[]) => Promise<number>;
  computeDiff?: (before: string, after: string) => Promise<string | null>;
  fastSearch?: (query: string, root: string, options?: { limit?: number; regex?: boolean }) => Promise<any[] | null>;
}

export class Agent {
  private readonly client: ChatProviderClient;
  private activeRequestController: AbortController | null = null;
  private stopRequested = false;

  constructor(private readonly options: AgentOptions) {
    this.client = createProviderClient(options.config.providers[options.session.provider]);
  }

  get session(): SessionState {
    return this.options.session;
  }

  requestStop(): void {
    this.stopRequested = true;
    this.activeRequestController?.abort();
  }

  async runTurn(userInput: string, streaming: boolean): Promise<void> {
    this.stopRequested = false;
    const userMessage = this.persistedMessage({
      role: "user",
      content: userInput
    });
    await this.options.sessionStore.appendMessage(this.options.session, userMessage);
    void appendHistoryEntry(this.options.config, this.options.session.id, userInput).catch(() => {
      // Best-effort history persistence.
    });

    const localGreeting = maybeLocalGreeting(userInput);

    if (localGreeting) {
      await this.appendAndRenderAssistantMessage(localGreeting, false);
      return;
    }

    const provider = this.options.config.providers[this.options.session.provider];
    const providerDefinition = getProviderDefinition(this.options.session.provider);

    if (!provider.authValue) {
      const missingAuthMessage =
        provider.authSource === "stored_hash"
          ? `A stored SHA-256 fingerprint exists for ${providerDefinition.label}, but the raw credential is not available in this process. Use /model to enter the key again or set ${providerDefinition.auth.envVars.join(", ")}.`
          : `${providerDefinition.label} credentials are missing. Set ${providerDefinition.auth.envVars.join(", ")} and try again.`;

      await this.appendAndRenderAssistantMessage(
        missingAuthMessage,
        false
      );
      return;
    }

    const seenToolCalls = new Set<string>();
    let repeatWarningInjected = 0;
    let consecutiveApiErrors = 0;

    while (true) {
      this.throwIfStopped();
      const conversation = compactConversation(
        this.options.session.messages,
        this.options.session.referencedFiles,
        this.options.config.memory
      );
      const recentCount = this.options.config.memory.recentMessageCount;
      this.options.ui.activity(
        conversation.compactedCount > 0
          ? `Using ${recentCount} recent messages and ${conversation.compactedCount} compacted earlier messages.`
          : "Using the live conversation context."
      );
      const systemPrompt = await this.systemPrompt(conversation.memory, conversation.compactedCount);
      const requestMessages = withSystemMessage(
        systemPrompt,
        conversation.recentMessages
      );
      let turn;

      try {
        turn = await this.completeTurn(requestMessages, streaming);
        consecutiveApiErrors = 0; // Reset on success
      } catch (error) {
        if (isAbortError(error) || error instanceof AgentInterruptedError) {
          this.options.ui.endAssistantTurn();
          throw new AgentInterruptedError();
        }

        consecutiveApiErrors += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (consecutiveApiErrors >= 3) {
          await this.appendAndRenderAssistantMessage(
            `I've encountered multiple consecutive API errors and must stop. Last error: ${errorMessage}`,
            true
          );
          return;
        }

        this.options.ui.warn(`API Error: ${errorMessage}`);
        this.options.ui.activity("Retrying automatically...");
        
        const syntheticUserMessage = this.persistedMessage({
          role: "user",
          content: `SYSTEM ALERT: The previous generation failed with an API error: ${errorMessage}\nIf you were generating a large file, you likely hit the maximum output token limit. Please try breaking your response down, or use the append_to_file tool to write large files in chunks.`
        });
        await this.options.sessionStore.appendMessage(this.options.session, syntheticUserMessage);
        
        continue;
      }

      const assistantMessage = this.persistedMessage({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.length > 0 ? turn.toolCalls : null
      });
      await this.options.sessionStore.appendMessage(this.options.session, assistantMessage);

      if (turn.toolCalls.length === 0) {
        this.options.ui.endAssistantTurn();
        return;
      }

      let suppressedRepeats = 0;
      for (const toolCall of turn.toolCalls) {
        this.throwIfStopped();
        this.options.ui.printToolCall(toolCall);
        const signature = toolCallSignature(toolCall);
        let result;

        if (seenToolCalls.has(signature)) {
          suppressedRepeats += 1;
          this.options.ui.activity(`Skipping repeated ${toolCall.function.name} call.`);
          result = {
            summary: "Repeated tool call suppressed",
            content: "This exact tool call already ran earlier in this turn. Reuse the earlier result instead of calling it again.",
            isError: true
          };
        } else {
          seenToolCalls.add(signature);
          this.options.ui.activity(`Running ${toolCall.function.name}.`);
          const toolSpec = this.options.tools.getTool(toolCall.function.name);
          const isMutating = toolSpec && !toolSpec.readOnly;
          
          result = await this.options.tools.execute(toolCall, this.toolContext());

          if (result.isError) {
            seenToolCalls.delete(signature);
          } else if (isMutating) {
            seenToolCalls.clear();
          }
        }

        this.throwIfStopped();
        this.options.ui.printToolResult(result.summary, result.isError);
        await this.options.sessionStore.appendMessage(
          this.options.session,
          this.persistedMessage({
            role: "tool",
            content: result.content,
            tool_call_id: toolCall.id
          })
        );
      }

      if (shouldInjectRepeatWarning(suppressedRepeats, repeatWarningInjected)) {
        repeatWarningInjected += 1;
        const warning = this.persistedMessage({
          role: "user",
          content: toolRepeatWarningMessage()
        });
        await this.options.sessionStore.appendMessage(this.options.session, warning);
      }
    }
  }

  private async completeTurn(messages: ChatMessage[], streaming: boolean): Promise<StreamedAssistantTurn> {
    this.options.ui.activity(`Thinking with ${providerLabel(this.options.session.provider)} / ${this.options.session.model}.`);
    const requestOptions = this.beginRequest();

    if (!streaming) {
      const spinner = this.options.ui.startSpinner("Thinking");

      try {
        const turn = await this.client.complete(this.chatRequest(messages), requestOptions);

        spinner.stop();
        if (turn.content) {
          this.options.ui.printAssistantMessage(turn.content);
        }

        return turn;
      } catch (error) {
        if (isAbortError(error)) {
          throw new AgentInterruptedError();
        }

        throw error;
      } finally {
        this.endRequest(requestOptions);
        if (spinner.isSpinning) {
          spinner.stop();
        }
      }
    }

    try {
      const turn = await this.client.stream(
        this.chatRequest(messages),
        {
          onText: (chunk) => this.options.ui.appendAssistantText(chunk)
        },
        requestOptions
      );
      if (turn.content) {
        this.options.ui.finalizeAssistantMessage(turn.content);
      }
      return turn;
    } catch (error) {
      if (isAbortError(error)) {
        this.options.ui.endAssistantTurn();
        throw new AgentInterruptedError();
      }

      this.options.ui.endAssistantTurn();
      this.options.ui.activity("Streaming failed. Retrying with buffered completion.");
      this.options.ui.warn(
        `Streaming failed, falling back to buffered completion: ${error instanceof Error ? error.message : String(error)}`
      );

      return this.completeTurn(messages, false);
    } finally {
      this.endRequest(requestOptions);
    }
  }

  private chatRequest(messages: ChatMessage[]) {
    return {
      messages,
      model: this.options.session.model,
      temperature: 0.2,
      reasoning_effort: getProviderDefinition(this.options.session.provider).supportsReasoningEffort
        ? this.options.config.reasoningEffort
        : null,
      tools: this.options.tools.toSarvamTools(),
      tool_choice: "auto" as const
    };
  }

  private toolContext(): ToolContext {
    return {
      cwd: process.cwd(),
      workspaceRoot: this.options.session.workspaceRoot,
      approvals: {
        requestApproval: (request) => this.options.approvals.requestApproval(request),
        hasSessionGrant: (key) => this.options.approvals.hasSessionGrant(key),
        registerReference: (targetPath) => this.options.approvals.registerReference(targetPath),
        ensureWebAccess: () => this.options.approvals.ensureWebAccess()
      },
      interaction: {
        askText: (prompt, placeholder = "") => this.options.requestTextInput(prompt, placeholder),
        askSelect: (prompt, options) => this.options.requestSelect(prompt, options)
      },
      performance: {
        computeDiff: (before, after) => this.options.computeDiff ? this.options.computeDiff(before, after) : Promise.resolve(null),
        fastSearch: (query, root, opts) => this.options.fastSearch ? this.options.fastSearch(query, root, opts) : Promise.resolve(null)
      },
      reads: {
        hasRead: (targetPath) => this.options.session.readFiles.includes(targetPath),
        registerRead: (targetPath) => this.options.sessionStore.appendReadFile(this.options.session, targetPath)
      },
      edits: {
        recordEdit: (edit) => this.options.sessionStore.appendEdit(this.options.session, edit)
      },
      paths: {
        resolve: (inputPath) => this.options.pathPolicy.resolve(inputPath),
        ensureReadable: (inputPath) => this.options.pathPolicy.ensureReadable(inputPath),
        ensureWritable: (inputPath) => this.options.pathPolicy.ensureWritable(inputPath),
        allowedRoots: () => this.options.pathPolicy.allowedRoots()
      },
      searchProvider: createSearchProvider(this.options.config.searchProviderName)
    };
  }

  private async appendAndRenderAssistantMessage(message: string, isError: boolean): Promise<void> {
    if (isError) {
      this.options.ui.error(message);
    } else {
      this.options.ui.printAssistantMessage(message);
    }

    await this.options.sessionStore.appendMessage(
      this.options.session,
      this.persistedMessage({
        role: "assistant",
        content: message
      })
    );
  }

  private persistedMessage(message: Omit<PersistedMessage, "timestamp">): PersistedMessage {
    return {
      ...message,
      timestamp: new Date().toISOString()
    };
  }

  private async systemPrompt(memory: string | null, compactedCount: number): Promise<string> {
    const skillInventory = await this.options.skills.inventoryPrompt();
    const pinnedSkillContext = await this.options.skills.pinnedPrompt();
    const [rulesPrompt, persistentMemory] = await Promise.all([
      loadRulesPrompt(this.options.config.contextFiles),
      this.options.config.memories.useMemories
        ? loadMemoriesPrompt(this.options.config.contextFiles)
        : Promise.resolve(null)
    ]);
    const lines = [
      "You are Vetala, an expert software engineer and AI coding assistant operating directly inside the user's terminal.",
      "When greeting or introducing yourself, explicitly call yourself Vetala.",
      "When referring to yourself in any response, use the name Vetala.",
      `Host platform: ${this.options.runtimeProfile.platform}`,
      `Host architecture: ${this.options.runtimeProfile.arch}`,
      `Host release: ${this.options.runtimeProfile.release}`,
      `Host OS version: ${this.options.runtimeProfile.osVersion}`,
      `Detected shell: ${this.options.runtimeProfile.shell}`,
      `Detected terminal: ${this.options.runtimeProfile.terminalProgram} / ${this.options.runtimeProfile.terminalType}`,
      `TTY: stdin=${this.options.runtimeProfile.stdinIsTTY ? "yes" : "no"}, stdout=${this.options.runtimeProfile.stdoutIsTTY ? "yes" : "no"}, size=${formatViewport(this.options.runtimeProfile)}`,
      "Account for the host platform, shell, and terminal when suggesting or running commands.",
      `Workspace root: ${this.options.session.workspaceRoot}`,
      `Active provider: ${providerLabel(this.options.session.provider)}`,
      `Active model: ${this.options.session.model}`,
      `Allowed roots right now: ${this.options.pathPolicy.allowedRoots().join(", ")}`,
      compactedCount > 0
        ? `Only the most recent messages are attached verbatim. ${compactedCount} earlier messages were compacted into working memory.`
        : "The full conversation is attached because the session is still short."
    ];

    if (rulesPrompt) {
      lines.push("", rulesPrompt);
    }

    lines.push("", skillInventory);

    if (pinnedSkillContext) {
      lines.push("", pinnedSkillContext);
    }

    if (persistentMemory) {
      lines.push("", persistentMemory);
    }

    if (memory) {
      lines.push("", memory);
    }

    return lines.join("\n");
  }

  private beginRequest(): ProviderRequestOptions {
    const controller = new AbortController();
    this.activeRequestController = controller;
    return { signal: controller.signal };
  }

  private endRequest(options: ProviderRequestOptions): void {
    if (this.activeRequestController?.signal === options.signal) {
      this.activeRequestController = null;
    }
  }

  private throwIfStopped(): void {
    if (this.stopRequested) {
      throw new AgentInterruptedError();
    }
  }
}

export class AgentInterruptedError extends Error {
  constructor() {
    super("The current turn was interrupted.");
    this.name = "AgentInterruptedError";
  }
}

export function isAgentInterruptedError(error: unknown): error is AgentInterruptedError {
  return error instanceof AgentInterruptedError;
}

function toolCallSignature(toolCall: StreamedAssistantTurn["toolCalls"][number]): string {
  try {
    return `${toolCall.function.name}:${JSON.stringify(JSON.parse(toolCall.function.arguments))}`;
  } catch {
    return `${toolCall.function.name}:${toolCall.function.arguments.trim()}`;
  }
}

function maybeLocalGreeting(userInput: string): string | null {
  const normalized = userInput.trim().toLowerCase();

  if (normalized === "hi" || normalized === "hello" || normalized === "hey") {
    return "Vetala here. How can I help?";
  }

  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatViewport(profile: RuntimeHostProfile): string {
  return profile.columns && profile.rows ? `${profile.columns}x${profile.rows}` : "unknown";
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "n":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function repeatWarningEnabled(): boolean {
  const value = envBool("VETALA_TOOL_REPEAT_WARN");
  return value ?? true;
}

function repeatWarningMax(): number {
  const value = envInt("VETALA_TOOL_REPEAT_WARN_MAX");
  if (value === undefined) {
    return 1;
  }
  return value;
}

function repeatWarningThreshold(): number {
  const value = envInt("VETALA_TOOL_REPEAT_WARN_THRESHOLD");
  if (value === undefined) {
    return 1;
  }
  return value;
}

function shouldInjectRepeatWarning(suppressedRepeats: number, alreadyInjected: number): boolean {
  if (!repeatWarningEnabled()) {
    return false;
  }
  if (suppressedRepeats < repeatWarningThreshold()) {
    return false;
  }
  const max = repeatWarningMax();
  if (max <= 0) {
    return true;
  }
  return alreadyInjected < max;
}

function toolRepeatWarningMessage(): string {
  const envMessage = process.env.VETALA_TOOL_REPEAT_WARN_MESSAGE;
  if (envMessage && envMessage.trim()) {
    return envMessage.trim();
  }
  return [
    "SYSTEM ALERT: Repeated tool calls were suppressed.",
    "Do not re-issue the same tool call in this turn.",
    "Reuse the earlier tool result and proceed with the answer.",
    "If more information is needed, ask a clarification question instead of calling tools again."
  ].join(" ");
}
