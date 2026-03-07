import { ApprovalManager } from "./approvals.js";
import { compactConversation } from "./context-memory.js";
import { PathPolicy } from "./path-policy.js";
import { DisabledSearchProvider } from "./search-provider.js";
import { SessionStore } from "./session-store.js";
import { SarvamClient, withSystemMessage } from "./sarvam/client.js";
import { TerminalUI } from "./terminal-ui.js";
import { ToolRegistry } from "./tools/registry.js";
import type { SkillRuntime } from "./skills/runtime.js";
import type {
  ChatMessage,
  EffectiveConfig,
  PersistedMessage,
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
  skills: SkillRuntime;
  tools: ToolRegistry;
  ui: TerminalUI;
}

export class Agent {
  private readonly client: SarvamClient;

  constructor(private readonly options: AgentOptions) {
    this.client = new SarvamClient(options.config);
  }

  get session(): SessionState {
    return this.options.session;
  }

  async runTurn(userInput: string, streaming: boolean): Promise<void> {
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

    if (!this.options.config.authValue) {
      const missingAuthMessage =
        this.options.config.authSource === "stored_hash"
          ? "A stored SHA-256 fingerprint exists, but the raw Sarvam key is not available in this process. Use /model to enter the key again or set SARVAM_API_KEY, SARVAM_SUBSCRIPTION_KEY, or SARVAM_TOKEN."
          : "Sarvam credentials are missing. Set SARVAM_API_KEY, SARVAM_SUBSCRIPTION_KEY, or SARVAM_TOKEN and try again.";

      await this.appendAndRenderAssistantMessage(
        missingAuthMessage,
        false
      );
      return;
    }

    const seenToolCalls = new Set<string>();

    for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
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
          result = await this.options.tools.execute(toolCall, this.toolContext());
        }

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
    this.options.ui.activity(`Thinking with ${this.options.session.model}.`);

    if (!streaming) {
      const spinner = this.options.ui.startSpinner("Thinking");

      try {
        const turn = await this.client.complete(this.chatRequest(messages));

        spinner.stop();
        if (turn.content) {
          this.options.ui.printAssistantMessage(turn.content);
        }

        return turn;
      } finally {
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
        }
      );
      return turn;
    } catch (error) {
      this.options.ui.endAssistantTurn();
      this.options.ui.activity("Streaming failed. Retrying with buffered completion.");
      this.options.ui.warn(
        `Streaming failed, falling back to buffered completion: ${error instanceof Error ? error.message : String(error)}`
      );

      return this.completeTurn(messages, false);
    }
  }

  private chatRequest(messages: ChatMessage[]) {
    return {
      messages,
      model: this.options.session.model,
      temperature: 0.2,
      reasoning_effort: this.options.config.reasoningEffort,
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
      reads: {
        hasRead: (targetPath) => this.options.session.readFiles.includes(targetPath),
        registerRead: (targetPath) => this.options.sessionStore.appendReadFile(this.options.session, targetPath)
      },
      paths: {
        resolve: (inputPath) => this.options.pathPolicy.resolve(inputPath),
        ensureReadable: (inputPath) => this.options.pathPolicy.ensureReadable(inputPath),
        ensureWritable: (inputPath) => this.options.pathPolicy.ensureWritable(inputPath),
        allowedRoots: () => this.options.pathPolicy.allowedRoots()
      },
      searchProvider: new DisabledSearchProvider()
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
      "You are Vetala, a concise coding CLI assistant operating inside a developer terminal.",
      "When greeting or introducing yourself, explicitly call yourself Vetala.",
      "When referring to yourself in any response, use the name Vetala.",
      `Host platform: ${process.platform}`,
      "Account for the host platform when suggesting or running shell commands.",
      `Workspace root: ${this.options.session.workspaceRoot}`,
      `Allowed roots right now: ${this.options.pathPolicy.allowedRoots().join(", ")}`,
      compactedCount > 0
        ? `Only the most recent messages are attached verbatim. ${compactedCount} earlier messages were compacted into working memory.`
        : "The full conversation is attached because the session is still short.",
      "Use tools whenever you need file contents, shell output, git state, or web data.",
      "Only call declared tools by their exact names.",
      "Preferred repo workflow: search_repo, then read_file/read_file_chunk/read_symbol, then apply_patch or write_file.",
      "Do not edit an existing file until you have read it in this session.",
      "Use the skill tool whenever a task may match a local skill or when you need a skill-specific file.",
      "When reading files inside the local skill catalog, prefer the skill tool over read_file.",
      "The skill tool supports list, load, read, pin, unpin, and clear.",
      "Do not repeat identical tool calls within the same turn. Reuse earlier tool results instead.",
      "Treat follow-up requests as continuing the current task unless the user clearly changes direction.",
      "Never claim to have inspected or changed files unless you actually used a tool.",
      "Prefer read-only tools before mutating tools or shell commands.",
      "If a tool is denied or errors, do not pretend it succeeded; adapt to the result.",
      "Keep responses short and focused on what changed, what you found, or what blocks progress.",
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
}

function toolCallSignature(toolCall: StreamedAssistantTurn["toolCalls"][number]): string {
  return `${toolCall.function.name}:${toolCall.function.arguments.trim()}`;
}

function maybeLocalGreeting(userInput: string): string | null {
  const normalized = userInput.trim().toLowerCase();

  if (normalized === "hi" || normalized === "hello" || normalized === "hey") {
    return "Vetala here. How can I help?";
  }

  return null;
}
