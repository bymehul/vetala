import { ApprovalManager } from "./approvals.js";
import { compactConversation } from "./context-memory.js";
import { advanceTurnPlan, analyzeTurnDeliberation, phaseForTool, updateTurnPlan } from "./deliberation.js";
import { loadMemoriesPrompt, loadRulesPrompt } from "./context-files.js";
import { appendHistoryEntry } from "./history-store.js";
import { PathPolicy } from "./path-policy.js";
import { createProviderClient, getProviderDefinition, providerLabel, withSystemMessage } from "./providers/index.js";
import { createSearchProvider } from "./search-provider.js";
import { SessionStore } from "./session-store.js";
import { TerminalUI } from "./terminal-ui.js";
import { ToolRegistry } from "./tools/registry.js";
import { formatTurnTargetList, resolveTurnTargets } from "./turn-targets.js";
import type { TurnPlan, TurnPlanStage } from "./deliberation.js";
import type { ChatProviderClient, ProviderRequestOptions } from "./providers/index.js";
import type { SkillRuntime } from "./skills/runtime.js";
import type {
  ChatMessage,
  EffectiveConfig,
  PersistedMessage,
  RuntimeHostProfile,
  SessionState,
  StreamedAssistantTurn,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolVerification
} from "./types.js";
import type { TaskKind } from "./deliberation.js";
import type { TurnTargetContext } from "./turn-targets.js";

export interface InvalidToolCall {
  toolName: string;
  rawArguments: string;
  reason: string;
}

export interface ToolCallPartition {
  validToolCalls: ToolCall[];
  invalidToolCalls: InvalidToolCall[];
}

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
  fastSearch?: (
    query: string,
    root: string,
    options?: { limit?: number; regex?: boolean; globs?: string[]; includeHidden?: boolean; signal?: AbortSignal }
  ) => Promise<any[] | null>;
}

interface TurnVerificationRecord extends ToolVerification {
  toolName: string;
}

const EMPTY_TURN_TARGETS: TurnTargetContext = {
  taskKind: "chat",
  explicitPaths: [],
  explicitFiles: [],
  explicitDirs: [],
  preferredRoot: null
};

export class Agent {
  private readonly client: ChatProviderClient;
  private activeRequestController: AbortController | null = null;
  private activeTurnController: AbortController | null = null;
  private stopRequested = false;
  private turnSkillPrompt: string | null = null;
  private turnDeliberationPrompt: string | null = null;
  private turnReasoningEffort: "low" | "medium" | "high" | null = null;
  private turnReasoningLabel = "none";
  private turnPlan: TurnPlan | null = null;
  private turnPlanSignature = "";
  private turnPlanInspected = false;
  private turnPlanHasMutation = false;
  private turnPlanHasVerification = false;
  private turnTaskKind: TaskKind = "chat";
  private turnTargets: TurnTargetContext = EMPTY_TURN_TARGETS;
  private turnChangedFiles = new Set<string>();
  private turnVerificationRecords: TurnVerificationRecord[] = [];
  private turnNoOpEdits: string[] = [];
  private turnVerificationNudges = 0;

  constructor(private readonly options: AgentOptions) {
    this.client = createProviderClient(options.config.providers[options.session.provider]);
  }

  get session(): SessionState {
    return this.options.session;
  }

  requestStop(): void {
    this.stopRequested = true;
    this.activeTurnController?.abort();
    this.activeRequestController?.abort();
  }

  async runTurn(userInput: string, streaming: boolean): Promise<void> {
    const turnController = new AbortController();
    this.activeTurnController = turnController;
    this.stopRequested = false;
    try {
      this.turnPlanInspected = false;
      this.turnPlanHasMutation = false;
      this.turnPlanHasVerification = false;
      this.turnTaskKind = "chat";
      this.turnTargets = EMPTY_TURN_TARGETS;
      this.turnChangedFiles.clear();
      this.turnVerificationRecords = [];
      this.turnNoOpEdits = [];
      this.turnVerificationNudges = 0;
      this.setTurnPlan(null);
      const userMessage = this.persistedMessage({
        role: "user",
        content: userInput
      });
      await this.options.sessionStore.appendMessage(this.options.session, userMessage);
      void appendHistoryEntry(this.options.config, this.options.session.id, userInput).catch(() => {
        // Best-effort history persistence.
      });

      this.turnSkillPrompt = null;
      this.options.ui.updateActiveSkills([]);
      const localGreeting = maybeLocalGreeting(userInput);

      if (localGreeting) {
        await this.appendAndRenderAssistantMessage(localGreeting, false);
        return;
      }

      const turnSkillContext = await this.options.skills.resolveTurnContext(userInput);
      this.turnSkillPrompt = turnSkillContext.prompt;
      this.options.ui.updateActiveSkills(turnSkillContext.labels);

      const provider = this.options.config.providers[this.options.session.provider];
      const providerDefinition = getProviderDefinition(this.options.session.provider);
      const deliberation = analyzeTurnDeliberation(userInput, {
        configuredEffort: providerDefinition.supportsReasoningEffort ? this.options.config.reasoningEffort : null,
        activeSkills: turnSkillContext.labels
      });
      this.turnTaskKind = deliberation.taskKind;
      this.turnTargets = await resolveTurnTargets(
        userInput,
        deliberation.taskKind,
        this.options.pathPolicy,
        this.options.session.workspaceRoot
      );
      this.turnDeliberationPrompt = deliberation.guidance;
      this.turnReasoningEffort = providerDefinition.supportsReasoningEffort ? deliberation.reasoningEffort : null;
      this.turnReasoningLabel = deliberation.reasoningLabel;
      this.options.ui.updateTurnState(this.turnReasoningLabel, "planning");
      if (deliberation.shouldShowThinking && deliberation.thinkingSummary) {
        this.options.ui.printThinking(deliberation.thinkingSummary);
      }
      if (deliberation.plan) {
        this.advanceCurrentPlan("inspect", deliberation.plan);
      }

      if (!provider.authValue) {
        this.setTurnPlan(null);
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
      let malformedToolCallRetries = 0;
      let sanitizedHistoryWarningShown = false;

      while (true) {
        this.throwIfStopped();
        const conversation = compactConversation(
          this.options.session.messages,
          this.options.session.referencedFiles,
          this.options.config.memory
        );
        const sanitizedConversation = sanitizeConversationMessages(conversation.recentMessages);
        const recentCount = this.options.config.memory.recentMessageCount;
        this.options.ui.activity(
          conversation.compactedCount > 0
            ? `Using ${recentCount} recent messages and ${conversation.compactedCount} compacted earlier messages.`
            : "Using the live conversation context."
        );
        if (sanitizedConversation.invalidToolCallCount > 0 && !sanitizedHistoryWarningShown) {
          sanitizedHistoryWarningShown = true;
          this.options.ui.activity(
            `Ignoring ${sanitizedConversation.invalidToolCallCount} malformed tool call${sanitizedConversation.invalidToolCallCount === 1 ? "" : "s"} from earlier session history.`
          );
        }
        const systemPrompt = await this.systemPrompt(conversation.memory, conversation.compactedCount);
        const requestMessages = withSystemMessage(
          systemPrompt,
          sanitizedConversation.messages
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

        const hasContent = typeof turn.content === "string" && turn.content.trim().length > 0;
        if (!hasContent && turn.toolCalls.length === 0) {
          if (emptyResponseWarningEnabled()) {
            this.options.ui.warn(emptyResponseWarningMessage());
          }
          this.options.ui.endAssistantTurn();
          return;
        }

        const partitionedToolCalls = partitionToolCalls(turn.toolCalls);
        if (partitionedToolCalls.invalidToolCalls.length > 0) {
          malformedToolCallRetries += 1;

          if (hasContent) {
            await this.options.sessionStore.appendMessage(
              this.options.session,
              this.persistedMessage({
                role: "assistant",
                content: turn.content,
                tool_calls: null
              })
            );
          }

          const summary = summarizeInvalidToolCalls(partitionedToolCalls.invalidToolCalls);
          this.options.ui.warn(
            `Model emitted malformed tool arguments${summary ? `: ${summary}` : ""}. Retrying with smaller, valid tool calls.`
          );

          if (malformedToolCallRetries >= 3) {
            await this.appendAndRenderAssistantMessage(
              `The model kept emitting malformed tool calls and I stopped before making changes. Last issue: ${summary || "invalid tool arguments"}.`,
              true
            );
            return;
          }

          await this.options.sessionStore.appendMessage(
            this.options.session,
            this.persistedMessage({
              role: "user",
              content: malformedToolCallRepairPrompt(partitionedToolCalls.invalidToolCalls)
            })
          );
          continue;
        }
        malformedToolCallRetries = 0;

        const assistantMessage = this.persistedMessage({
          role: "assistant",
          content: turn.content || null,
          tool_calls: partitionedToolCalls.validToolCalls.length > 0 ? partitionedToolCalls.validToolCalls : null
        });
        await this.options.sessionStore.appendMessage(this.options.session, assistantMessage);

        if (partitionedToolCalls.validToolCalls.length === 0) {
          const verificationPrompt = this.pendingVerificationPrompt();
          if (verificationPrompt) {
            this.turnVerificationNudges += 1;
            await this.options.sessionStore.appendMessage(
              this.options.session,
              this.persistedMessage({
                role: "user",
                content: verificationPrompt
              })
            );
            continue;
          }
          this.finalizeCurrentPlan();
          this.options.ui.endAssistantTurn();
          return;
        }

        let suppressedRepeats = 0;
        for (const toolCall of partitionedToolCalls.validToolCalls) {
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
            this.options.ui.updateTurnState(this.turnReasoningLabel, phaseForTool(toolCall.function.name));
            this.options.ui.activity(`Running ${toolCall.function.name}.`);
            const toolSpec = this.options.tools.getTool(toolCall.function.name);
            const isMutating = Boolean(toolSpec && !toolSpec.readOnly);

            try {
              result = await this.options.tools.execute(toolCall, this.toolContext(turnController));
            } catch (error) {
              if (isAbortError(error) || error instanceof AgentInterruptedError) {
                this.options.ui.endAssistantTurn();
                throw new AgentInterruptedError();
              }
              throw error;
            }
            this.observeToolResult(toolCall.function.name, isMutating, result);

            if (result.isError) {
              seenToolCalls.delete(signature);
            } else if (isMutating) {
              seenToolCalls.clear();
            }
          }

          this.throwIfStopped();
          this.options.ui.printToolResult(result.summary, result.isError, result.content);
          this.options.ui.activity("Thinking...");
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
        this.options.ui.updateTurnState(this.turnReasoningLabel, "thinking");
      }
    } finally {
      if (this.activeTurnController === turnController) {
        this.activeTurnController = null;
      }
      this.turnSkillPrompt = null;
      this.turnDeliberationPrompt = null;
      this.turnReasoningEffort = null;
      this.turnReasoningLabel = "none";
      this.turnTaskKind = "chat";
      this.turnTargets = EMPTY_TURN_TARGETS;
      this.turnChangedFiles.clear();
      this.turnVerificationRecords = [];
      this.turnNoOpEdits = [];
      this.turnVerificationNudges = 0;
      this.turnPlanInspected = false;
      this.turnPlanHasMutation = false;
      this.turnPlanHasVerification = false;
      this.options.ui.updateTurnState(null, null);
    }
  }

  private async completeTurn(messages: ChatMessage[], streaming: boolean): Promise<StreamedAssistantTurn> {
    this.options.ui.updateTurnState(this.turnReasoningLabel, "thinking");
    this.options.ui.activity(`Thinking with ${providerLabel(this.options.session.provider)} / ${this.options.session.model} (${this.turnReasoningLabel} reasoning).`);
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

      this.options.ui.discardAssistantDraft();
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
        ? this.turnReasoningEffort
        : null,
      tools: this.options.tools.toSarvamTools(),
      tool_choice: "auto" as const
    };
  }

  private toolContext(turnController: AbortController): ToolContext {
    return {
      cwd: process.cwd(),
      workspaceRoot: this.options.session.workspaceRoot,
      turn: {
        taskKind: this.turnTaskKind,
        explicitPaths: [...this.turnTargets.explicitPaths],
        explicitFiles: [...this.turnTargets.explicitFiles],
        explicitDirs: [...this.turnTargets.explicitDirs],
        preferredRoot: this.turnTargets.preferredRoot,
        changedFiles: [...this.turnChangedFiles]
      },
      lifecycle: {
        signal: turnController.signal,
        throwIfAborted: () => {
          if (turnController.signal.aborted || this.stopRequested) {
            throw new AgentInterruptedError();
          }
        }
      },
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
        fastSearch: (query, root, opts) => this.options.fastSearch ? this.options.fastSearch(query, root, {
          ...opts,
          signal: turnController.signal
        }) : Promise.resolve(null)
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
      "When using tools, emit valid JSON object arguments only.",
      "Prefer smaller tool calls over giant payloads. Break large refactors and large apply_patch edits into multiple steps.",
      "When the user names a concrete file path, read that file directly with read_file or read_file_chunk before considering search_repo.",
      "If the user named concrete files or directories, stay scoped to them unless you have concrete evidence that broader repo context is required.",
      "When active skill guidance is already injected below, use it directly. Do not call the skill tool again unless you need a specific deeper file that is not already summarized.",
      "For non-trivial tasks, form a concise plan before acting and execute it incrementally.",
      "If the target, scope, or acceptance criteria remain unclear after initial inspection, use ask_user before editing.",
      "For source-file edits, prefer targeted diagnostics on the named file or changed file before and after editing when available.",
      "Do not claim a build, test, or diagnostics check verified your change unless the tool output explicitly supports that claim.",
      "For Git-aware tasks, prefer the dedicated git tools over ad-hoc shell commands.",
      "For change review, start with git_review targeting the full worktree so you cover staged, unstaged, and untracked files.",
      "For branch review, compare against the merge base with the requested base branch instead of assuming HEAD~1 or the previous commit.",
      "Use git_log and git_blame when history or ownership helps explain why code exists.",
      "Do not commit, push, or create branches unless the user explicitly asks.",
      compactedCount > 0
        ? `Only the most recent messages are attached verbatim. ${compactedCount} earlier messages were compacted into working memory.`
        : "The full conversation is attached because the session is still short."
    ];

    if (rulesPrompt) {
      lines.push("", rulesPrompt);
    }

    lines.push("", skillInventory);

    if (this.turnTargets.explicitPaths.length > 0) {
      lines.push(
        "",
        [
          "Concrete turn targets:",
          `- named targets: ${formatTurnTargetList(this.turnTargets.explicitPaths, this.options.session.workspaceRoot)}`,
          this.turnTargets.preferredRoot
            ? `- preferred root: ${formatTurnTargetList([this.turnTargets.preferredRoot], this.options.session.workspaceRoot)}`
            : "- preferred root: (none)"
        ].join("\n")
      );
    }

    if (this.turnSkillPrompt) {
      lines.push("", this.turnSkillPrompt);
    }

    if (this.turnDeliberationPrompt) {
      lines.push("", this.turnDeliberationPrompt);
    }

    const executionPrompt = this.currentExecutionPrompt();
    if (executionPrompt) {
      lines.push("", executionPrompt);
    }

    if (persistentMemory) {
      lines.push("", persistentMemory);
    }

    if (memory) {
      lines.push("", memory);
    }

    return lines.join("\n");
  }

  private currentExecutionPrompt(): string | null {
    const lines: string[] = [];

    if (this.turnChangedFiles.size > 0) {
      lines.push(`- changed files: ${formatTurnTargetList([...this.turnChangedFiles], this.options.session.workspaceRoot)}`);
    }

    if (this.turnVerificationRecords.length > 0) {
      const latest = this.turnVerificationRecords[this.turnVerificationRecords.length - 1]!;
      lines.push(
        `- latest verification: ${latest.toolName} -> ${latest.trusted ? "trusted" : "untrusted"} / ${latest.passed ? "passed" : "failed"}`
      );
      if (latest.reason) {
        lines.push(`- verification note: ${latest.reason}`);
      }
    } else if (this.turnChangedFiles.size > 0) {
      lines.push("- verification: none yet");
    }

    if (this.turnNoOpEdits.length > 0) {
      lines.push(`- no-op edit attempts: ${this.turnNoOpEdits.length}`);
    }

    if (lines.length === 0) {
      return null;
    }

    return [
      "Current turn execution state:",
      ...lines,
      "- Only summarize changes that actually happened in the changed files listed above.",
      "- If verification is missing or untrusted, verify first or explicitly say so."
    ].join("\n");
  }

  private pendingVerificationPrompt(): string | null {
    if (this.turnTaskKind !== "edit" || !this.turnPlanHasMutation || this.turnPlanHasVerification) {
      return null;
    }

    if (this.turnVerificationNudges >= 3) {
      return null;
    }

    const changedFiles = [...this.turnChangedFiles];
    const targets = changedFiles.length > 0 ? changedFiles : this.turnTargets.explicitFiles;
    const formattedTargets = formatTurnTargetList(targets, this.options.session.workspaceRoot);

    if (this.turnVerificationNudges >= 2) {
      return [
        "SYSTEM ALERT: Trustworthy verification is still missing for this edit.",
        `Changed or named targets: ${formattedTargets}.`,
        "If you cannot verify in this environment, say that explicitly and do not claim the change is verified or all tests passed."
      ].join("\n");
    }

    return [
      "SYSTEM ALERT: You changed files but have not yet produced trustworthy verification for them.",
      `Changed or named targets: ${formattedTargets}.`,
      "Before finalizing, run get_diagnostics on the changed file or run a build/test/check command that actually validates the changed scope.",
      "Do not claim success until verification is trustworthy."
    ].join("\n");
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

  private advanceCurrentPlan(stage: TurnPlanStage, planOverride?: TurnPlan | null): void {
    const next = advanceTurnPlan(planOverride ?? this.turnPlan, stage);
    this.setTurnPlan(next);
  }

  private observeToolResult(toolName: string, isMutating: boolean, result: ToolResult): void {
    const phase = phaseForTool(toolName);
    const meta = result.meta;

    if (meta?.noOp) {
      this.turnNoOpEdits.push(result.summary);
    }

    for (const changedFile of meta?.changedFiles ?? []) {
      this.turnChangedFiles.add(changedFile);
    }

    if (meta?.verification) {
      this.turnVerificationRecords.push({
        ...meta.verification,
        toolName
      });
    }

    const inspected = meta?.inspectedPaths?.length ? meta.inspectedPaths : [];
    if ((inspected.length > 0 || (phase === "inspecting" && !result.isError)) && !this.turnPlanInspected) {
      this.turnPlanInspected = true;
      this.setTurnPlan(updateTurnPlan(this.turnPlan, {
        completed: ["inspect"],
        inProgress: "decide"
      }));
    }

    if (isMutating && !result.isError && (meta?.changedFiles?.length ?? 0) > 0) {
      this.turnPlanHasMutation = true;
      this.setTurnPlan(updateTurnPlan(this.turnPlan, {
        completed: ["inspect", "decide"],
        inProgress: "execute"
      }));
    }

    if (
      meta?.verification &&
      meta.verification.trusted &&
      meta.verification.passed &&
      this.turnPlanHasMutation
    ) {
      this.turnPlanHasVerification = true;
      this.setTurnPlan(updateTurnPlan(this.turnPlan, {
        completed: ["inspect", "decide", "execute"],
        inProgress: "summarize"
      }));
    }
  }

  private finalizeCurrentPlan(): void {
    if (!this.turnPlan) {
      return;
    }

    if (this.turnPlan.taskKind === "edit") {
      if (this.turnPlanHasMutation && this.turnPlanHasVerification) {
        this.advanceCurrentPlan("complete");
        return;
      }

      if (this.turnPlanHasMutation) {
        this.setTurnPlan(updateTurnPlan(this.turnPlan, {
          completed: ["inspect", "decide", "execute"],
          inProgress: null
        }));
        return;
      }

      if (this.turnPlanInspected) {
        this.setTurnPlan(updateTurnPlan(this.turnPlan, {
          completed: ["inspect"],
          inProgress: "decide"
        }));
      }
      return;
    }

    if (this.turnPlanInspected) {
      this.advanceCurrentPlan("complete");
    }
  }

  private setTurnPlan(plan: TurnPlan | null): void {
    this.turnPlan = cloneTurnPlan(plan);
    const signature = this.turnPlan ? JSON.stringify(this.turnPlan) : "";
    if (signature === this.turnPlanSignature) {
      return;
    }
    this.turnPlanSignature = signature;
    this.options.ui.updatePlan(cloneTurnPlan(this.turnPlan));
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

export function partitionToolCalls(toolCalls: ToolCall[]): ToolCallPartition {
  const validToolCalls: ToolCall[] = [];
  const invalidToolCalls: InvalidToolCall[] = [];

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name.trim();
    if (!toolName) {
      invalidToolCalls.push({
        toolName: "(unknown tool)",
        rawArguments: toolCall.function.arguments,
        reason: "Missing tool name."
      });
      continue;
    }

    const validationError = validateToolCallArguments(toolCall.function.arguments);
    if (validationError) {
      invalidToolCalls.push({
        toolName,
        rawArguments: toolCall.function.arguments,
        reason: validationError
      });
      continue;
    }

    validToolCalls.push(toolCall);
  }

  return { validToolCalls, invalidToolCalls };
}

export function sanitizeConversationMessages<T extends ChatMessage>(messages: T[]): {
  messages: T[];
  invalidToolCallCount: number;
} {
  const sanitized: T[] = [];
  let invalidToolCallCount = 0;

  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls || message.tool_calls.length === 0) {
      sanitized.push(message);
      continue;
    }

    const partition = partitionToolCalls(message.tool_calls);
    invalidToolCallCount += partition.invalidToolCalls.length;

    if (partition.invalidToolCalls.length === 0) {
      sanitized.push(message);
      continue;
    }

    if ((message.content ?? "").trim() === "" && partition.validToolCalls.length === 0) {
      continue;
    }

    const copy = { ...message } as T & { tool_calls?: ToolCall[] | null };
    delete copy.tool_calls;
    if (partition.validToolCalls.length > 0) {
      copy.tool_calls = partition.validToolCalls;
    }
    sanitized.push(copy);
  }

  return { messages: sanitized, invalidToolCallCount };
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

function validateToolCallArguments(rawArguments: string): string | null {
  if (!rawArguments.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Tool arguments must be a JSON object.";
  }

  return null;
}

function malformedToolCallRepairPrompt(invalidToolCalls: InvalidToolCall[]): string {
  const tools = [...new Set(invalidToolCalls.map((issue) => issue.toolName))];
  const lines = [
    "SYSTEM ALERT: The previous assistant turn emitted malformed tool-call JSON, so those tools were not executed.",
    `Affected tools: ${tools.join(", ")}.`,
    "Retry the same intent, but emit valid JSON object arguments only.",
    "Keep tool calls small and precise. Split large refactors or large apply_patch edits into multiple smaller tool calls."
  ];

  const applyPatchAffected = tools.some((name) => name === "apply_patch" || name === "replace_in_file");
  if (applyPatchAffected) {
    lines.push("For file edits, prefer smaller exact hunks with short search/replace blocks instead of one giant patch payload.");
  }

  const firstIssue = invalidToolCalls[0];
  if (firstIssue) {
    lines.push(`Last parse error: ${firstIssue.toolName}: ${firstIssue.reason}`);
  }

  lines.push("Continue the original request.");
  return lines.join("\n");
}

function summarizeInvalidToolCalls(invalidToolCalls: InvalidToolCall[]): string {
  const first = invalidToolCalls[0];
  if (!first) {
    return "";
  }
  const extra = invalidToolCalls.length - 1;
  return `${first.toolName}: ${first.reason}${extra > 0 ? ` (+${extra} more)` : ""}`;
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
    "Continue the original request; use different ranges if you need more of the file.",
    "If more information is needed, ask a clarification question instead of calling tools again."
  ].join(" ");
}

function emptyResponseWarningEnabled(): boolean {
  const value = envBool("VETALA_EMPTY_RESPONSE_WARN");
  return value ?? true;
}

function emptyResponseWarningMessage(): string {
  const envMessage = process.env.VETALA_EMPTY_RESPONSE_WARN_MESSAGE;
  if (envMessage && envMessage.trim()) {
    return envMessage.trim();
  }
  return "Model returned an empty response (possible context limit). Try resuming with a shorter scope.";
}

function cloneTurnPlan(plan: TurnPlan | null): TurnPlan | null {
  if (!plan) {
    return null;
  }
  return {
    taskKind: plan.taskKind,
    title: plan.title,
    explanation: plan.explanation,
    steps: plan.steps.map((step) => ({ ...step }))
  };
}
