import { ApprovalManager } from "./approvals.js";
import { compactConversation } from "./context-memory.js";
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
    const maxLoops = 100;

    for (let turnIndex = 0; turnIndex < maxLoops; turnIndex += 1) {
      this.throwIfStopped();
      const conversation = compactConversation(
        this.options.session.messages,
        this.options.session.referencedFiles
      );
      this.options.ui.activity(
        conversation.compactedCount > 0
          ? `Using 12 recent messages and ${conversation.compactedCount} compacted earlier messages.`
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
      } catch (error) {
        if (isAbortError(error) || error instanceof AgentInterruptedError) {
          this.options.ui.endAssistantTurn();
          throw new AgentInterruptedError();
        }

        await this.appendAndRenderAssistantMessage(
          error instanceof Error ? error.message : String(error),
          true
        );
        return;
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

      for (const toolCall of turn.toolCalls) {
        this.throwIfStopped();
        this.options.ui.printToolCall(toolCall);
        const signature = toolCallSignature(toolCall);
        let result;

        if (seenToolCalls.has(signature)) {
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
    }

    throw new Error("Agent reached the maximum tool loop depth.");
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
        askUser: (prompt) => this.options.requestTextInput("Vetala asks", prompt)
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
        : "The full conversation is attached because the session is still short.",
      "",
      "# CORE REASONING & TOOL PROTOCOL (CRITICAL)",
      "1. PLAN BEFORE ACTING: Always explicitly formulate a plan. For complex tasks, break them down. Use tools systematically to explore the environment.",
      "2. EMPIRICAL VERIFICATION (NO HALLUCINATIONS): Never assume the contents of a file, the structure of a project, or the existence of a command. ALWAYS use tools to verify your assumptions before editing code.",
      "3. VALIDATE YOUR WORK: After making changes (via write_file, apply_patch, or run_shell), use search, read, or test commands to strictly confirm the changes were applied correctly and the code compiles/runs.",
      "4. PREFER SPECIFIC TOOLS: If a specialized tool exists (e.g., search_repo, read_file), use it instead of running generic shell commands (e.g., 'grep' or 'cat' via run_shell).",
      "5. INCREMENTAL PROGRESS: Take small, verified steps. If a tool call fails, analyze the error, adjust your approach, and try again. Do not silently ignore errors or pretend they succeeded.",
      "6. CONCISE COMMUNICATION: Keep your text responses incredibly concise. Do not mechanically narrate your tool usage. Focus on the technical outcome, strategy, or blocking issues.",
      "",
      "# WORKFLOW GUIDELINES",
      "- Exploration: Start with `search_repo` or directory listing to map the codebase context.",
      "- Comprehension: Use `read_file` to understand exact context before proposing modifications.",
      "- Modification: Use `apply_patch` for surgical edits or `write_file` for new files. Follow up by running tests/linters via `run_shell` if applicable.",
      "- Wait/Delay: If a command needs time before the next check, use `sleep`.",
      "- Long Commands: Set `timeout_ms` explicitly for slow builds or test runs in `run_shell`.",
      "- Web Research: If unsure about APIs, dependency versions, or obscure errors, use `web_search` or `stack_overflow_search` instead of guessing.",
      "- Skills: Use the `skill` tool whenever a task aligns with a local skill. It supports list, load, read, pin, unpin.",
      "",
      "Do not repeat identical tool calls in the same turn. Treat follow-up requests as continuing the current task.",
      "",
      skillInventory
    ];

    if (pinnedSkillContext) {
      lines.push("", pinnedSkillContext);
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
