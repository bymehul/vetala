import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { Agent, isAgentInterruptedError } from "../agent.js";
import { latestUndoableEdit, undoLastEdit } from "../edit-history.js";
import { ApprovalManager } from "../approvals.js";
import {
  clearProviderSavedAuth,
  loadConfig,
  providerConfigFor,
  saveProviderDefaults,
  saveProviderPersistentAuth,
  withProviderSessionAuth,
  withProviderStoredAuth
} from "../config.js";
import { PathPolicy } from "../path-policy.js";
import { getProviderDefinition, listProviders, providerLabel } from "../providers/index.js";
import { SessionStore } from "../session-store.js";
import { SkillRuntime } from "../skills/runtime.js";
import type { SkillCatalogEntry } from "../skills/types.js";
import { createToolRegistry } from "../tools/index.js";
import { buildTranscriptCards } from "./transcript-cards.js";
import type {
  ApprovalRequest,
  ApprovalScope,
  EffectiveConfig,
  ProviderName,
  ReasoningEffort,
  RuntimeHostProfile,
  SessionListItem,
  SessionState
} from "../types.js";
import { InkTerminalUI, type InkEntryKind, type InkUiEntry } from "./ink-terminal-ui.js";
import { buildSlashSuggestions } from "./command-suggestions.js";

const ASSISTANT_FLUSH_INTERVAL_MS = 33;
const MAX_LIVE_ASSISTANT_LINES = 24;
const MAX_VISIBLE_TRANSCRIPT_TURNS = 6;
const UI_COLORS = {
  accent: "blue",
  muted: "gray",
  border: "gray",
  warning: "yellow",
  danger: "red"
} as const;

interface ReplAppProps {
  initialConfig: EffectiveConfig;
  initialSession: SessionState;
  runtimeProfile: RuntimeHostProfile;
  store: SessionStore;
}

interface ApprovalPromptState {
  request: ApprovalRequest;
  resolve: (scope: ApprovalScope) => void;
}

interface BusyPromptState {
  prompt: string;
}

interface AuthInputState {
  provider: ProviderName;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  authMode: "bearer" | "subscription_key";
  value: string;
}

type AuthRetentionChoice = "persist" | "session" | "cancel";
type BusyPromptChoice = "force" | "queue" | "cancel";
type ReasoningEffortChoice = ReasoningEffort | "none" | "cancel";

interface ModelSetupState {
  provider: ProviderName;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

interface OpenRouterModelIdState {
  provider: "openrouter";
  value: string;
}

type ModelChoice = ProviderName | "cancel";

export function ReplApp({ initialConfig, initialSession, runtimeProfile, store }: ReplAppProps) {
  const { exit } = useApp();
  const [config, setConfig] = useState(initialConfig);
  const [session, setSession] = useState(() => cloneSession(initialSession));
  const [trusted, setTrusted] = useState(false);
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<InkUiEntry[]>([]);
  const [assistantBuffer, setAssistantBuffer] = useState("");
  const [activityLabel, setActivityLabel] = useState<string | null>(null);
  const [spinnerLabel, setSpinnerLabel] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [pendingApproval, setPendingApproval] = useState<ApprovalPromptState | null>(null);
  const [pendingBusyPrompt, setPendingBusyPrompt] = useState<BusyPromptState | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingSarvamModelPicker, setPendingSarvamModelPicker] = useState<"sarvam" | null>(null);
  const [pendingOpenRouterModelInput, setPendingOpenRouterModelInput] = useState<OpenRouterModelIdState | null>(null);
  const [pendingReasoningSetup, setPendingReasoningSetup] = useState<ModelSetupState | null>(null);
  const [pendingAuthInput, setPendingAuthInput] = useState<AuthInputState | null>(null);
  const [pendingAuthRetention, setPendingAuthRetention] = useState<AuthInputState | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [pendingExitConfirm, setPendingExitConfirm] = useState(false);
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const [turnRunning, setTurnRunning] = useState(false);
  const assistantBufferRef = useRef("");
  const assistantFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextEntryIdRef = useRef(0);
  const queuedPromptRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  const turnRunningRef = useRef(false);
  const uiRef = useRef<InkTerminalUI | null>(null);
  const skillRuntimeRef = useRef<SkillRuntime | null>(null);
  const activeAgentRef = useRef<Agent | null>(null);

  sessionRef.current = session;

  const pushEntry = (kind: InkEntryKind, text: string) => {
    setEntries((current) => [
      ...current,
      {
        id: String(nextEntryIdRef.current++),
        kind,
        text
      }
    ]);
  };

  const flushAssistantBuffer = () => {
    if (assistantFlushTimerRef.current) {
      clearTimeout(assistantFlushTimerRef.current);
      assistantFlushTimerRef.current = null;
    }

    setAssistantBuffer(assistantBufferRef.current);
  };

  const scheduleAssistantFlush = () => {
    if (assistantFlushTimerRef.current) {
      return;
    }

    assistantFlushTimerRef.current = setTimeout(() => {
      assistantFlushTimerRef.current = null;
      setAssistantBuffer(assistantBufferRef.current);
    }, ASSISTANT_FLUSH_INTERVAL_MS);
  };

  const finalizeAssistant = () => {
    flushAssistantBuffer();
    const buffered = assistantBufferRef.current.trimEnd();

    if (!buffered) {
      assistantBufferRef.current = "";
      setAssistantBuffer("");
      return;
    }

    assistantBufferRef.current = "";
    setAssistantBuffer("");
    pushEntry("assistant", buffered);
  };

  if (!uiRef.current) {
    uiRef.current = new InkTerminalUI({
      appendAssistant: (text) => {
        assistantBufferRef.current += text;
        scheduleAssistantFlush();
      },
      finalizeAssistant,
      pushEntry,
      setActivity: (label) => {
        setActivityLabel(label);
      },
      setSpinner: (label) => {
        setSpinnerLabel(label);
        setStatus(label ?? "Ready");
      }
    }, runtimeProfile);
  }

  const ui = uiRef.current;
  if (!skillRuntimeRef.current) {
    skillRuntimeRef.current = new SkillRuntime({
      getSession: () => sessionRef.current,
      sessionStore: store
    });
  }
  const skills = skillRuntimeRef.current;
  const visibleStatus = paused ? "Paused" : status;
  const visibleAssistantBuffer = renderLiveAssistantBuffer(assistantBuffer);
  const transcriptCards = buildTranscriptCards(entries);
  const visibleTranscriptCards = transcriptCards.slice(-MAX_VISIBLE_TRANSCRIPT_TURNS);
  const hiddenTranscriptTurnCount = Math.max(0, transcriptCards.length - visibleTranscriptCards.length);
  const slashSuggestions = buildSlashSuggestions(input, availableSkills).slice(0, 8);
  const showSlashSuggestions = Boolean(
    trusted &&
    !turnRunning &&
    !paused &&
    !pendingExitConfirm &&
    !pendingApproval &&
    !pendingBusyPrompt &&
    !modelPickerOpen &&
    !pendingSarvamModelPicker &&
    !pendingOpenRouterModelInput &&
    !pendingReasoningSetup &&
    !pendingAuthInput &&
    !pendingAuthRetention &&
    input.startsWith("/") &&
    slashSuggestions.length > 0
  );
  const createTools = () =>
    createToolRegistry({
      includeWebSearch: config.searchProviderName !== "disabled",
      skillRuntime: skills
    });

  useEffect(() => {
    let cancelled = false;

    void skills
      .listSkills()
      .then((listed) => {
        if (!cancelled) {
          setAvailableSkills(listed);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableSkills([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [skills]);

  useEffect(() => () => {
    if (assistantFlushTimerRef.current) {
      clearTimeout(assistantFlushTimerRef.current);
    }
  }, []);

  useInput((inputValue, key) => {
    if (showSlashSuggestions && isTabInput(inputValue, key)) {
      const firstSuggestion = slashSuggestions[0];

      if (firstSuggestion) {
        setInput(firstSuggestion.completion);
      }

      return;
    }

    if (isControlInput(inputValue, key, "d", "\u0004")) {
      setPendingExitConfirm(true);
      return;
    }

    if (!trusted) {
      return;
    }

    if (isControlInput(inputValue, key, "c", "\u0003")) {
      setPendingExitConfirm(false);
      setPaused((current) => !current);
      return;
    }
  });

  const requestApprovalDecision = (request: ApprovalRequest) =>
    new Promise<ApprovalScope>((resolve) => {
      setActivityLabel("Waiting for approval.");
      setPendingApproval({ request, resolve });
    });

  const syncSession = (nextSession: SessionState) => {
    const cloned = cloneSession(nextSession);
    setSession(cloned);
    return cloned;
  };

  const resetTranscript = () => {
    flushAssistantBuffer();
    assistantBufferRef.current = "";
    setAssistantBuffer("");
    setActivityLabel(null);
    nextEntryIdRef.current = 0;
    setEntries([]);
  };

  const mergeLoadedConfig = (loaded: EffectiveConfig, skipProvider?: ProviderName): EffectiveConfig => {
    let merged = loaded;

    for (const provider of listProviders()) {
      if (provider.name === skipProvider) {
        continue;
      }

      const currentProfile = config.providers[provider.name];

      if (
        currentProfile.authSource === "session" &&
        currentProfile.authValue &&
        currentProfile.authMode !== "missing"
      ) {
        merged = withProviderSessionAuth(
          merged,
          provider.name,
          currentProfile.authMode,
          currentProfile.authValue
        );
      }
    }

    return merged;
  };

  const closeCommandModals = () => {
    setModelPickerOpen(false);
    setPendingSarvamModelPicker(null);
    setPendingOpenRouterModelInput(null);
    setPendingReasoningSetup(null);
    setPendingAuthInput(null);
    setPendingAuthRetention(null);
  };

  const setQueuedPromptState = (prompt: string | null) => {
    queuedPromptRef.current = prompt;
    setQueuedPrompt(prompt);
  };

  const setTurnRunningState = (value: boolean) => {
    turnRunningRef.current = value;
    setTurnRunning(value);
  };

  const beginQueuedPrompt = (prompt: string) => {
    setQueuedPromptState(null);
    setPendingBusyPrompt(null);
    void runPrompt(prompt, { forceRun: true });
  };

  const runPrompt = async (prompt: string, options: { forceRun?: boolean } = {}) => {
    const trimmed = prompt.trim();

    if (!trimmed) {
      return;
    }

    if (turnRunningRef.current && !options.forceRun) {
      setPendingBusyPrompt({ prompt: trimmed });
      setInput("");
      return;
    }

    if (trimmed.startsWith("/")) {
      setInput("");
      await handleCommand(trimmed);
      return;
    }

    setInput("");
    setPendingExitConfirm(false);
    setPendingBusyPrompt(null);
    setActivityLabel(null);
    pushEntry("user", summarizeUserPrompt(trimmed));
    setStatus("Running agent");

    const approvals = new ApprovalManager(session, store, null, requestApprovalDecision);
    const agent = new Agent({
      config,
      session,
      sessionStore: store,
      approvals,
      pathPolicy: new PathPolicy(session.workspaceRoot, approvals),
      runtimeProfile,
      skills,
      tools: createTools(),
      ui
    });
    activeAgentRef.current = agent;
    setTurnRunningState(true);

    try {
      await agent.runTurn(trimmed, true);
      syncSession(session);
      setActivityLabel(null);
      setStatus(queuedPromptRef.current ? "Running queued prompt" : "Ready");
    } catch (error) {
      if (isAgentInterruptedError(error)) {
        setActivityLabel(null);
        syncSession(session);
        setStatus(queuedPromptRef.current ? "Running queued prompt" : "Interrupted");
        return;
      }

      finalizeAssistant();
      setActivityLabel(null);
      pushEntry("error", error instanceof Error ? error.message : String(error));
      setStatus("Failed");
      syncSession(session);
    } finally {
      activeAgentRef.current = null;
      setTurnRunningState(false);

      const nextQueuedPrompt = queuedPromptRef.current;
      if (nextQueuedPrompt) {
        beginQueuedPrompt(nextQueuedPrompt);
      }
    }
  };

  const handleCommand = async (commandLine: string) => {
    const [command, ...args] = commandLine.slice(1).split(/\s+/);
    setInput("");
    setActivityLabel(null);
    pushEntry("user", commandLine);

    switch (command) {
      case "help":
        pushEntry(
          "info",
          [
            "/help",
            "/model",
            "/undo",
            "/skill",
            "/tools",
            "/history",
            "/resume <session-id>",
            "/new",
            "/approve",
            "/config",
            "/logout",
            "/clear",
            "/exit"
          ].join("\n")
        );
        return;
      case "model":
        if (args.length > 0) {
          pushEntry("warn", "/model is interactive now. Use /model and select from the list.");
        }
        closeCommandModals();
        setModelPickerOpen(true);
        setStatus("Select a provider and model");
        return;
      case "undo": {
        const result = await undoLastEdit(session, store, (request) => {
          const approvals = new ApprovalManager(session, store, null, requestApprovalDecision);
          return approvals.requestApproval(request);
        });
        syncSession(session);
        pushEntry(result.isError ? "warn" : "info", result.content);
        setStatus(result.isError ? "Undo blocked" : "Ready");
        return;
      }
      case "skill":
      case "skills":
        await handleSkillsCommand(args);
        return;
      case "tools":
        pushEntry(
          "info",
          createTools()
            .list()
            .map((tool) => `${tool.readOnly ? "ro" : "rw"} ${tool.name} - ${tool.description}`)
            .join("\n")
        );
        return;
      case "history":
        pushEntry(
          "info",
          session.messages
            .slice(-20)
            .map((message) => {
              const label = message.role.padEnd(9, " ");
              const content = (message.content ?? "[tool call]").replace(/\s+/g, " ").slice(0, 140);
              return `${label} ${content}`;
            })
            .join("\n") || "(empty session)"
        );
        return;
      case "resume": {
        const target = args[0];

        if (!target) {
          const sessions = await store.listSessions();
          pushEntry("info", formatSessionList(sessions));
          return;
        }

        const nextSession = await store.loadSession(target);
        const nextCloned = syncSession(nextSession);
        closeCommandModals();
        resetTranscript();
        setStatus(`Resumed ${nextCloned.id.slice(0, 8)}`);
        return;
      }
      case "new": {
        const nextSession = await store.createSession(session.workspaceRoot, session.provider, session.model);
        const nextCloned = syncSession(nextSession);
        closeCommandModals();
        resetTranscript();
        setStatus(`Created ${nextCloned.id.slice(0, 8)}`);
        return;
      }
      case "approve":
        pushEntry(
          "info",
          [
            `web access: ${session.approvals.webAccess ? "granted" : "not granted"}`,
            `path grants: ${session.approvals.outOfTreeRoots.join(", ") || "(none)"}`,
            `session grants: ${session.approvals.sessionActionKeys.join(", ") || "(none)"}`
          ].join("\n")
        );
        return;
      case "config":
        ui.printConfig(config);
        return;
      case "logout": {
        const previousProfile = providerConfigFor(config, session.provider);
        await clearProviderSavedAuth(session.provider);
        closeCommandModals();

        const reloaded = mergeLoadedConfig(await loadConfig(), session.provider);
        setConfig(reloaded);

        if (providerConfigFor(reloaded, session.provider).authSource === "env") {
          pushEntry(
            "warn",
            `Cleared local ${providerLabel(session.provider)} auth state, but environment credentials are still active for this process.`
          );
        } else if (previousProfile.authSource === "stored" || previousProfile.authSource === "stored_hash") {
          pushEntry("info", `Cleared the saved ${providerLabel(session.provider)} credential for future launches.`);
        } else if (previousProfile.authSource === "session") {
          pushEntry("info", `Cleared the ${providerLabel(session.provider)} credential that was only active in this session.`);
        } else {
          pushEntry("info", `No saved ${providerLabel(session.provider)} credential remained after logout.`);
        }

        setStatus("Logged out");
        return;
      }
      case "clear":
        closeCommandModals();
        resetTranscript();
        setStatus("Ready");
        return;
      case "exit":
        setPendingExitConfirm(true);
        return;
      default:
        pushEntry("warn", `Unknown command: /${command}`);
    }
  };

  const handleSkillsCommand = async (args: string[]) => {
    try {
      const [subcommand, ...rest] = args;

      if (!subcommand) {
        const available = await skills.listSkills();
        const pinned = new Set((await skills.pinnedSkills()).map((skill) => skill.name));
        pushEntry(
          "info",
          available.length > 0
            ? available
                .map((skill) => `${pinned.has(skill.name) ? "*" : "-"} ${skill.name} - ${skill.description || "(no description)"}`)
                .join("\n")
            : "(no skills available)"
        );
        return;
      }

      switch (subcommand) {
        case "use":
        case "pin": {
          const name = rest[0];

          if (!name) {
            pushEntry("warn", "Usage: /skill use <name>");
            return;
          }

          const skill = await skills.pinSkill(name);
          syncSession(session);
          pushEntry("info", `Pinned skill: ${skill.name}`);
          return;
        }
        case "drop":
        case "unpin": {
          const name = rest[0];

          if (!name) {
            pushEntry("warn", "Usage: /skill drop <name>");
            return;
          }

          const skill = await skills.unpinSkill(name);
          syncSession(session);
          pushEntry("info", `Unpinned skill: ${skill.name}`);
          return;
        }
        case "clear": {
          const cleared = await skills.clearPinnedSkills();
          syncSession(session);
          pushEntry("info", cleared > 0 ? `Cleared ${cleared} pinned skills.` : "No pinned skills were active.");
          return;
        }
        case "show":
        case "load": {
          const name = rest[0];

          if (!name) {
            pushEntry("warn", "Usage: /skill show <name>");
            return;
          }

          const skill = await skills.loadSkill(name);
          pushEntry("info", skill.overview);
          return;
        }
        case "read": {
          const [name, ...pathParts] = rest;

          if (!name) {
            pushEntry("warn", "Usage: /skill read <name> [path]");
            return;
          }

          const pathArg = pathParts.join(" ") || "SKILL.md";
          const file = await skills.readSkillFile(name, pathArg);
          pushEntry("info", file.content);
          return;
        }
        default:
          pushEntry("warn", "Usage: /skill [use|drop|clear|show|read]");
      }
    } catch (error) {
      pushEntry("error", error instanceof Error ? error.message : String(error));
    }
  };

  const onTrustSelect = async (value: "trust" | "exit") => {
    if (value === "exit") {
      exit();
      return;
    }

    setTrusted(true);
    setStatus("Ready");
  };

  const onApprovalSelect = async (value: ApprovalScope) => {
    const promptState = pendingApproval;

    if (!promptState) {
      return;
    }

    setActivityLabel(null);
    setPendingApproval(null);
    promptState.resolve(value);
  };

  const onBusyPromptSelect = async (choice: BusyPromptChoice) => {
    const current = pendingBusyPrompt;

    if (!current) {
      return;
    }

    if (choice === "cancel") {
      setPendingBusyPrompt(null);
      setInput(current.prompt);
      return;
    }

    const replacedExistingQueue = queuedPromptRef.current !== null;
    setQueuedPromptState(current.prompt);
    setPendingBusyPrompt(null);

    pushEntry(
      "info",
      choice === "force"
        ? `Stopping the current turn and sending next: ${summarizeUserPrompt(current.prompt)}`
        : `${replacedExistingQueue ? "Replaced" : "Queued"} next prompt: ${summarizeUserPrompt(current.prompt)}`
    );

    if (choice === "force") {
      setStatus("Stopping current turn");
      activeAgentRef.current?.requestStop();
      return;
    }

    setStatus("Queued next prompt");
  };

  const applyModelSelection = async (nextSettings: ModelSetupState) => {
    const definition = getProviderDefinition(nextSettings.provider);

    await store.updateModel(session, nextSettings.provider, nextSettings.model);
    await saveProviderDefaults(
      nextSettings.provider,
      nextSettings.model,
      definition.supportsReasoningEffort
        ? { reasoningEffort: nextSettings.reasoningEffort }
        : {}
    );
    syncSession(session);

    const nextConfig = mergeLoadedConfig(await loadConfig());
    setConfig(nextConfig);

    const nextProfile = providerConfigFor(nextConfig, nextSettings.provider);
    if (nextProfile.authSource === "missing" || nextProfile.authSource === "stored_hash") {
      setPendingAuthInput({
        ...nextSettings,
        authMode: definition.auth.defaultMode,
        value: ""
      });
      setStatus(`Enter ${definition.auth.inputLabel.toLowerCase()} for ${providerLabel(nextSettings.provider)} / ${nextSettings.model}`);
      return;
    }

    pushEntry("info", formatModelSetupSummary(nextSettings, nextConfig));
    setStatus("Ready");
  };

  const onModelSelect = async (value: ModelChoice) => {
    if (value === "cancel") {
      setModelPickerOpen(false);
      setStatus("Ready");
      return;
    }

    setModelPickerOpen(false);

    if (value === "sarvam") {
      setPendingSarvamModelPicker("sarvam");
      setStatus("Select a Sarvam model");
      return;
    }

    setPendingOpenRouterModelInput({
      provider: "openrouter",
      value: session.provider === "openrouter" ? session.model : providerConfigFor(config, "openrouter").defaultModel
    });
    setStatus("Enter an OpenRouter model id");
  };

  const onSarvamModelSelect = async (value: string | "cancel") => {
    if (value === "cancel") {
      setPendingSarvamModelPicker(null);
      setStatus("Ready");
      return;
    }

    setPendingSarvamModelPicker(null);
    setPendingReasoningSetup({
      provider: "sarvam",
      model: value,
      reasoningEffort: config.reasoningEffort
    });
    setStatus(`Select reasoning effort for Sarvam / ${value}`);
  };

  const onReasoningSelect = async (value: ReasoningEffortChoice) => {
    const current = pendingReasoningSetup;

    if (!current) {
      return;
    }

    if (value === "cancel") {
      setPendingReasoningSetup(null);
      setStatus("Ready");
      return;
    }

    setPendingReasoningSetup(null);
    const nextSettings = {
      ...current,
      reasoningEffort: value === "none" ? null : value
    };

    await applyModelSelection(nextSettings);
  };

  const onOpenRouterModelInputChange = (value: string) => {
    setPendingOpenRouterModelInput((current) => (current ? { ...current, value } : current));
  };

  const onOpenRouterModelInputSubmit = async (value: string) => {
    const trimmed = value.trim();

    if (!pendingOpenRouterModelInput) {
      return;
    }

    if (!trimmed) {
      setPendingOpenRouterModelInput(null);
      pushEntry("warn", "OpenRouter model selection cancelled.");
      setStatus("Ready");
      return;
    }

    setPendingOpenRouterModelInput(null);
    await applyModelSelection({
      provider: "openrouter",
      model: trimmed,
      reasoningEffort: null
    });
  };

  const onAuthInputChange = (value: string) => {
    setPendingAuthInput((current) => (current ? { ...current, value } : current));
  };

  const onAuthInputSubmit = async (value: string) => {
    const current = pendingAuthInput;

    if (!current) {
      return;
    }

    const trimmed = value.trim();

    if (!trimmed) {
      setPendingAuthInput(null);
      pushEntry(
        "warn",
        `Credential entry cancelled. Model settings were saved, but no usable ${providerLabel(current.provider)} credential is active.`
      );
      setStatus("Ready");
      return;
    }

    setPendingAuthInput(null);
    setPendingAuthRetention({
      ...current,
      value: trimmed
    });
    setStatus("Choose how long to keep this credential");
  };

  const onAuthRetentionSelect = async (choice: AuthRetentionChoice) => {
    const current = pendingAuthRetention;

    if (!current) {
      return;
    }

    if (choice === "cancel") {
      setPendingAuthRetention(null);
      pushEntry("warn", "API key setup cancelled.");
      setStatus("Ready");
      return;
    }

    const loadedConfig = await loadConfig();
    const nextConfig =
      choice === "persist"
        ? withProviderStoredAuth(loadedConfig, current.provider, current.authMode, current.value)
        : withProviderSessionAuth(loadedConfig, current.provider, current.authMode, current.value);

    if (choice === "persist") {
      await saveProviderPersistentAuth(current.provider, current.authMode, current.value);
    }

    setConfig(nextConfig);
    setPendingAuthRetention(null);
    pushEntry("info", formatModelSetupSummary(current, nextConfig, choice));

    if (choice === "persist" && providerConfigFor(loadedConfig, current.provider).authSource === "env") {
      pushEntry(
        "warn",
        "Environment credentials are still set in this shell. They may take precedence on future launches."
      );
    }

    setStatus("Ready");
  };

  const onExitConfirmSelect = async (value: "exit" | "stay") => {
    if (value === "exit") {
      exit();
      return;
    }

    setPendingExitConfirm(false);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {!trusted ? (
        <>
          <TrustScreen workspaceRoot={session.workspaceRoot} onSelect={onTrustSelect} />
          {pendingExitConfirm ? <ExitConfirmBox onSelect={onExitConfirmSelect} /> : null}
        </>
      ) : (
        <>
          <Dashboard config={config} session={session} status={visibleStatus} />
          <Box marginTop={1} flexDirection="column">
            {entries.length === 0 && !assistantBuffer && !spinnerLabel ? (
              <Box borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
                <Text color={UI_COLORS.muted}>New transcript. Use /history if you want earlier session messages.</Text>
              </Box>
            ) : null}

            {hiddenTranscriptTurnCount > 0 ? (
              <Box marginBottom={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
                <Text color={UI_COLORS.muted}>
                  {hiddenTranscriptTurnCount} earlier turn{hiddenTranscriptTurnCount === 1 ? "" : "s"} hidden. Use /history to inspect older messages or /clear to reset the visible transcript.
                </Text>
              </Box>
            ) : null}

            {visibleTranscriptCards.map((card) => (
              <TranscriptTurnCard key={card.id} card={card} />
            ))}

            {(assistantBuffer || activityLabel || spinnerLabel) ? (
              <LiveStatusCard
                assistantBuffer={visibleAssistantBuffer}
                liveLabel={activityLabel ?? spinnerLabel}
              />
            ) : null}
          </Box>

          {pendingExitConfirm ? (
            <ExitConfirmBox onSelect={onExitConfirmSelect} />
          ) : paused ? (
            <PauseBox />
          ) : pendingApproval ? (
            <ApprovalBox request={pendingApproval.request} onSelect={onApprovalSelect} />
          ) : pendingBusyPrompt ? (
            <BusyPromptBox prompt={pendingBusyPrompt.prompt} onSelect={onBusyPromptSelect} />
          ) : modelPickerOpen ? (
            <ModelPicker currentProvider={session.provider} onSelect={onModelSelect} />
          ) : pendingSarvamModelPicker ? (
            <SarvamModelPicker currentModel={session.provider === "sarvam" ? session.model : null} onSelect={onSarvamModelSelect} />
          ) : pendingOpenRouterModelInput ? (
            <OpenRouterModelIdBox
              state={pendingOpenRouterModelInput}
              onChange={onOpenRouterModelInputChange}
              onSubmit={onOpenRouterModelInputSubmit}
            />
          ) : pendingReasoningSetup ? (
            <ReasoningEffortPicker
              currentValue={pendingReasoningSetup.reasoningEffort}
              provider={pendingReasoningSetup.provider}
              model={pendingReasoningSetup.model}
              onSelect={onReasoningSelect}
            />
          ) : pendingAuthInput ? (
            <AuthInputBox
              state={pendingAuthInput}
              onChange={onAuthInputChange}
              onSubmit={onAuthInputSubmit}
            />
          ) : pendingAuthRetention ? (
            <AuthRetentionBox state={pendingAuthRetention} onSelect={onAuthRetentionSelect} />
          ) : (
            <>
              <InputBox
                busy={turnRunning}
                value={input}
                onChange={setInput}
                onSubmit={runPrompt}
              />
              {showSlashSuggestions ? <SlashSuggestionBox suggestions={slashSuggestions} /> : null}
            </>
          )}

          <Footer
            config={config}
            queuedPrompt={queuedPrompt}
            status={visibleStatus}
            session={session}
          />
        </>
      )}
    </Box>
  );
}

function Dashboard({
  config,
  session,
  status
}: {
  config: EffectiveConfig;
  session: SessionState;
  status: string;
}) {
  const activeProvider = providerConfigFor(config, session.provider);
  const infoRows = [
    { item: "provider", value: providerLabel(session.provider) },
    { item: "model", value: session.model },
    { item: "directory", value: session.workspaceRoot },
    { item: "session", value: session.id.slice(0, 8) },
    { item: "updated", value: formatTimestamp(session.updatedAt) }
  ];

  const stateRows = [
    { item: "auth", value: describeAuth(activeProvider) },
    { item: "reasoning", value: formatReasoningEffort(config.reasoningEffort, session.provider) },
    { item: "skills", value: describeSkills(session.pinnedSkills.length) },
    { item: "undo", value: latestUndoableEdit(session) ? "ready" : "none" },
    { item: "sha256", value: activeProvider.authFingerprint?.slice(0, 12) ?? "(none)" },
    { item: "context", value: describeContext(session.messages.length) }
  ];

  return (
    <>
      <Box borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="row">
        <Box flexDirection="column" width="60%" paddingRight={2}>
          <Text color={UI_COLORS.accent}>Vetala</Text>
          <Text bold>Ready.</Text>
          <Box marginTop={1} flexDirection="column">
            {infoRows.map((row) => (
              <InfoRow key={row.item} item={row.item} value={row.value} />
            ))}
          </Box>
        </Box>

        <Box flexDirection="column" width="40%">
          <Text color={UI_COLORS.accent}>Tips</Text>
          <Text>/help for commands</Text>
          <Text>/model for provider + model</Text>
          <Text>/undo to revert last edit</Text>
          <Text>/skill to inspect local skills</Text>
          <Text>/logout to clear local auth</Text>
          <Text>Ctrl+C to pause</Text>
          <Text>Ctrl+D to exit</Text>
          <Box marginTop={1}>
            <Text color={UI_COLORS.muted}>status: {status}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={UI_COLORS.accent}>Context</Text>
          </Box>
          {stateRows.map((row) => (
            <InfoRow key={row.item} item={row.item} value={row.value} />
          ))}
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
        <Text>Try "explain this codebase" or "write a test for &lt;filepath&gt;"</Text>
      </Box>
    </>
  );
}

function InfoRow({ item, value }: { item: string; value: string }) {
  return (
    <Box>
      <Box width={12}>
        <Text color={UI_COLORS.muted}>{item}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

function TrustScreen({
  workspaceRoot,
  onSelect
}: {
  workspaceRoot: string;
  onSelect: (value: "trust" | "exit") => Promise<void>;
}) {
  return (
    <Box borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Accessing workspace</Text>
      <Box marginTop={1}>
        <Text>{workspaceRoot}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Quick safety check: is this a project you created or one you trust? If not, review it before
          continuing.
        </Text>
        <Box marginTop={1}>
          <Text>Vetala will be able to read, edit, and execute files here.</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "Yes, I trust this folder", value: "trust" as const },
            { label: "No, exit", value: "exit" as const }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function ApprovalBox({
  request,
  onSelect
}: {
  request: ApprovalRequest;
  onSelect: (value: ApprovalScope) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.warning} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.warning}>Approval required</Text>
      {request.label.split("\n").map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "Allow once", value: "once" as const },
            { label: "Allow for session", value: "session" as const },
            { label: "Deny", value: "deny" as const }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function ModelPicker({
  currentProvider,
  onSelect
}: {
  currentProvider: ProviderName;
  onSelect: (value: ModelChoice) => Promise<void>;
}) {
  const items: Array<{ label: string; value: ModelChoice }> = [
    ...listProviders().map((provider) => ({
      label: provider.name === currentProvider ? `${provider.label} (current)` : provider.label,
      value: provider.name
    })),
    { label: "Cancel", value: "cancel" as const }
  ];

  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Select provider</Text>
      <Text color={UI_COLORS.muted}>Current: {providerLabel(currentProvider)}</Text>
      <Box marginTop={1}>
        <SelectInput<ModelChoice>
          items={items}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function SarvamModelPicker({
  currentModel,
  onSelect
}: {
  currentModel: string | null;
  onSelect: (value: string | "cancel") => Promise<void>;
}) {
  const items = [
    ...getProviderDefinition("sarvam").suggestedModels.map((model) => ({
      label: model === currentModel ? `${model} (current)` : model,
      value: model
    })),
    { label: "Cancel", value: "cancel" as const }
  ];

  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Select a Sarvam model</Text>
      <Text color={UI_COLORS.muted}>After model selection, Vetala will ask for reasoning effort.</Text>
      <Box marginTop={1}>
        <SelectInput<string | "cancel">
          items={items}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function OpenRouterModelIdBox({
  state,
  onChange,
  onSubmit
}: {
  state: OpenRouterModelIdState;
  onChange: (value: string) => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Enter an OpenRouter model id</Text>
      <Text color={UI_COLORS.muted}>Examples: `openai/gpt-4o-mini`, `anthropic/claude-3.5-haiku`, `google/gemini-2.0-flash-001`</Text>
      <Text color={UI_COLORS.muted}>Reasoning differs by OpenRouter model. Vetala will use the provider default instead of forcing one global reasoning setting.</Text>
      <Text color={UI_COLORS.muted}>Press Enter on an empty field to cancel.</Text>
      <Box marginTop={1}>
        <Text color={UI_COLORS.accent}>model </Text>
        <TextInput
          highlightPastedText={false}
          value={state.value}
          onChange={onChange}
          onSubmit={(value) => void onSubmit(value)}
        />
      </Box>
    </Box>
  );
}

function ReasoningEffortPicker({
  currentValue,
  provider,
  model,
  onSelect
}: {
  currentValue: ReasoningEffort | null;
  provider: ProviderName;
  model: string;
  onSelect: (value: ReasoningEffortChoice) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Select reasoning effort</Text>
      <Text color={UI_COLORS.muted}>
        Provider: {providerLabel(provider)} · Model: {model} · Current: {formatReasoningEffort(currentValue, provider)}
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "None (null / let Sarvam decide)", value: "none" as const },
            { label: "Low", value: "low" as const },
            { label: "Medium", value: "medium" as const },
            { label: "High", value: "high" as const },
            { label: "Cancel", value: "cancel" as const }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function AuthInputBox({
  state,
  onChange,
  onSubmit
}: {
  state: AuthInputState;
  onChange: (value: string) => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const definition = getProviderDefinition(state.provider);

  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Enter {definition.auth.inputLabel.toLowerCase()} for {providerLabel(state.provider)} / {state.model}</Text>
      <Text color={UI_COLORS.muted}>
        {definition.auth.helpText} After you press Enter, choose whether Vetala keeps it for all sessions
        or only for this session.
      </Text>
      <Text color={UI_COLORS.muted}>Reasoning: {formatReasoningEffort(state.reasoningEffort, state.provider)}</Text>
      <Text color={UI_COLORS.muted}>Press Enter on an empty field to cancel.</Text>
      <Box marginTop={1}>
        <Text color={UI_COLORS.accent}>key </Text>
        <TextInput
          mask="*"
          highlightPastedText={false}
          value={state.value}
          onChange={onChange}
          onSubmit={(value) => void onSubmit(value)}
        />
      </Box>
    </Box>
  );
}

function AuthRetentionBox({
  state,
  onSelect
}: {
  state: AuthInputState;
  onSelect: (value: AuthRetentionChoice) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Keep credential for {providerLabel(state.provider)} / {state.model}</Text>
      <Text color={UI_COLORS.muted}>Key preview: {maskSecretPreview(state.value)}</Text>
      <Text color={UI_COLORS.muted}>Reasoning: {formatReasoningEffort(state.reasoningEffort, state.provider)}</Text>
      <Text color={UI_COLORS.muted}>Future-session mode stores the raw key locally until you run /logout.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Choose how long Vetala should keep this key:</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            {
              label: "Keep for all sessions until /logout",
              value: "persist" as const
            },
            {
              label: "This session only",
              value: "session" as const
            },
            {
              label: "Cancel",
              value: "cancel" as const
            }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function InputBox({
  busy,
  value,
  onChange,
  onSubmit
}: {
  busy: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
      <Text color={UI_COLORS.accent}>❯ </Text>
      <TextInput
        highlightPastedText={false}
        value={value}
        onChange={onChange}
        onSubmit={(nextValue) => void onSubmit(nextValue)}
      />
      {busy ? <Text color={UI_COLORS.muted}>  Enter to queue or force-send.</Text> : null}
    </Box>
  );
}

function BusyPromptBox({
  prompt,
  onSelect
}: {
  prompt: string;
  onSelect: (value: BusyPromptChoice) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.warning} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.warning}>Current turn is still running</Text>
      <Text color={UI_COLORS.muted}>Choose what to do with the next prompt:</Text>
      <Box marginTop={1} flexDirection="column">
        {summarizeUserPrompt(prompt).split("\n").map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <SelectInput<BusyPromptChoice>
          items={[
            {
              label: "Send now (stop current turn)",
              value: "force"
            },
            {
              label: "Send after current turn",
              value: "queue"
            },
            {
              label: "Cancel",
              value: "cancel"
            }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function SlashSuggestionBox({
  suggestions
}: {
  suggestions: ReturnType<typeof buildSlashSuggestions>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Commands</Text>
      <Text color={UI_COLORS.muted}>Tab autocompletes the first match.</Text>
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.label}>
          <Box width="45%">
            {index === 0 ? (
              <Text color={UI_COLORS.accent}>
                ❯ {suggestion.label}
              </Text>
            ) : (
              <Text>  {suggestion.label}</Text>
            )}
          </Box>
          <Text color={UI_COLORS.muted}>{suggestion.detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

function PauseBox() {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
      <Text color={UI_COLORS.accent}>Paused</Text>
      <Text>Press Ctrl+C again to resume.</Text>
      <Text>Press Ctrl+D if you want to exit.</Text>
    </Box>
  );
}

function ExitConfirmBox({
  onSelect
}: {
  onSelect: (value: "exit" | "stay") => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text color="red">Exit Vetala?</Text>
      <Text color={UI_COLORS.muted}>Current session state is already written to disk as it changes.</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "Exit", value: "exit" as const },
            { label: "Stay", value: "stay" as const }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function Footer({
  config,
  queuedPrompt,
  status,
  session
}: {
  config: EffectiveConfig;
  queuedPrompt: string | null;
  status: string;
  session: SessionState;
}) {
  const activeProvider = providerConfigFor(config, session.provider);

  return (
    <Box marginTop={1} justifyContent="space-between">
      <Text color={UI_COLORS.muted}>/help for commands · /undo reverts last edit · Ctrl+C pause · Ctrl+D exit</Text>
      <Text color={UI_COLORS.muted}>
        {status}{queuedPrompt ? " · queued next prompt" : ""} · {describeAuth(activeProvider)} · {describeContext(session.messages.length)}
      </Text>
    </Box>
  );
}

function TranscriptTurnCard({
  card
}: {
  card: ReturnType<typeof buildTranscriptCards>[number];
}) {
  const borderColor = transcriptCardBorder(card.entries);

  return (
    <Box marginBottom={1} borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {card.entries.map((entry) => (
        <TranscriptSection key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}

function LiveStatusCard({
  assistantBuffer,
  liveLabel
}: {
  assistantBuffer: string;
  liveLabel: string | null;
}) {
  return (
    <Box marginBottom={1} borderStyle="round" borderColor={UI_COLORS.accent} paddingX={1} flexDirection="column">
      {liveLabel ? <LiveActivitySection label={liveLabel} /> : null}
      {assistantBuffer ? (
        <TranscriptSection entry={{ id: "live:assistant", kind: "assistant", text: assistantBuffer }} />
      ) : null}
    </Box>
  );
}

function TranscriptSection({ entry }: { entry: InkUiEntry }) {
  const isActivity = entry.kind === "activity";
  const labelColor = entryColor(entry.kind);

  return (
    <Box marginBottom={1} flexDirection="column">
      {labelColor ? <Text color={labelColor}>{entryLabel(entry.kind)}</Text> : <Text>{entryLabel(entry.kind)}</Text>}
      {entry.text.split("\n").map((line, index) =>
        isActivity ? (
          <Text key={`${entry.id}:${index}`} color={UI_COLORS.muted}>
            {line.length > 0 ? line : " "}
          </Text>
        ) : (
          <Text key={`${entry.id}:${index}`}>{line.length > 0 ? line : " "}</Text>
        )
      )}
    </Box>
  );
}

function LiveActivitySection({ label }: { label: string }) {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text color={UI_COLORS.muted}>doing</Text>
      <Box>
        <Text color={UI_COLORS.accent}>
          <Spinner type="dots" />
        </Text>
        <Text color={UI_COLORS.muted}> {label}</Text>
      </Box>
    </Box>
  );
}

function cloneSession(session: SessionState): SessionState {
  return {
    ...session,
    approvals: {
      sessionActionKeys: [...session.approvals.sessionActionKeys],
      outOfTreeRoots: [...session.approvals.outOfTreeRoots],
      webAccess: session.approvals.webAccess
    },
    messages: [...session.messages],
    referencedFiles: [...session.referencedFiles],
    readFiles: [...session.readFiles],
    pinnedSkills: [...session.pinnedSkills],
    edits: session.edits.map((edit) => ({ ...edit }))
  };
}

function formatSessionList(sessions: SessionListItem[]): string {
  return sessions.length > 0
    ? sessions
        .slice(0, 10)
        .map((item) => `${item.id}  ${item.provider}/${item.model}  ${item.updatedAt}  ${item.workspaceRoot}`)
        .join("\n")
    : "(no sessions)";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function describeAuth(config: EffectiveConfig["providers"][ProviderName]): string {
  switch (config.authSource) {
    case "env":
      return `${renderAuthMode(config.authMode)} from env`;
    case "session":
      return `${renderAuthMode(config.authMode)} in session`;
    case "stored":
      return `${renderAuthMode(config.authMode)} saved locally`;
    case "stored_hash":
      return `${renderAuthMode(config.authMode)} fingerprint only`;
    case "missing":
      return "missing";
  }
}

function formatReasoningEffort(value: ReasoningEffort | null, provider: ProviderName): string {
  if (!getProviderDefinition(provider).supportsReasoningEffort) {
    return "provider default (model-specific)";
  }

  return value ?? "(none)";
}

function describeSkills(pinnedCount: number): string {
  return pinnedCount > 0 ? `${pinnedCount} pinned` : "none pinned";
}

function formatModelSetupSummary(
  state: Pick<AuthInputState, "provider" | "model" | "reasoningEffort">,
  config: EffectiveConfig,
  authRetention?: Exclude<AuthRetentionChoice, "cancel">
): string {
  const profile = providerConfigFor(config, state.provider);
  const lines = [
    `Provider: ${providerLabel(state.provider)}`,
    `Model: ${state.model}`,
    `Reasoning effort: ${formatReasoningEffort(state.reasoningEffort, state.provider)}`,
    `Credential: ${describeAuth(profile)}`,
    `Stored SHA-256: ${profile.authFingerprint?.slice(0, 16) ?? "(none)"}`
  ];

  if (authRetention === "persist") {
    lines.push("Raw key is stored locally for all future sessions until /logout.");
  } else if (authRetention === "session") {
    lines.push("Raw key is kept only in memory for this session.");
  }

  return lines.join("\n");
}

function describeContext(messageCount: number): string {
  if (messageCount <= 12) {
    return `${messageCount} live messages`;
  }

  return `${messageCount - 12} compacted, 12 live`;
}

function summarizeUserPrompt(prompt: string): string {
  const lineCount = prompt.split("\n").length;
  const hasLargePaste = prompt.length > 260 || lineCount > 6;

  if (!hasLargePaste) {
    return prompt;
  }

  const preview = prompt.replace(/\s+/g, " ").trim().slice(0, 120);
  return [
    `Pasted content: ${prompt.length} chars, ${lineCount} lines`,
    `Preview: ${preview}${preview.length < prompt.replace(/\s+/g, " ").trim().length ? "..." : ""}`
  ].join("\n");
}

function renderLiveAssistantBuffer(buffer: string): string {
  if (!buffer) {
    return "";
  }

  const lines = buffer.split("\n");

  if (lines.length <= MAX_LIVE_ASSISTANT_LINES) {
    return buffer;
  }

  const hiddenLineCount = lines.length - MAX_LIVE_ASSISTANT_LINES;
  return [
    `[${hiddenLineCount} earlier line${hiddenLineCount === 1 ? "" : "s"} hidden while streaming]`,
    ...lines.slice(-MAX_LIVE_ASSISTANT_LINES)
  ].join("\n");
}

function renderAuthMode(authMode: EffectiveConfig["authMode"]): string {
  switch (authMode) {
    case "bearer":
      return "bearer token";
    case "subscription_key":
      return "API key";
    case "missing":
      return "missing";
  }
}

function isControlInput(
  inputValue: string,
  key: { ctrl?: boolean },
  expectedKey: string,
  rawControlChar: string
): boolean {
  return (key.ctrl && inputValue.toLowerCase() === expectedKey) || inputValue === rawControlChar;
}

function isTabInput(inputValue: string, key: { tab?: boolean }): boolean {
  return key.tab === true || inputValue === "\t";
}

function maskSecretPreview(value: string): string {
  const compact = value.trim();

  if (compact.length <= 8) {
    return compact;
  }

  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

function entryColor(kind: InkEntryKind) {
  switch (kind) {
    case "assistant":
      return UI_COLORS.accent;
    case "user":
      return undefined;
    case "tool":
      return UI_COLORS.accent;
    case "activity":
      return UI_COLORS.muted;
    case "info":
      return UI_COLORS.accent;
    case "warn":
      return UI_COLORS.warning;
    case "error":
      return UI_COLORS.danger;
  }
}

function entryLabel(kind: InkEntryKind) {
  switch (kind) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "tool":
      return "tool";
    case "activity":
      return "doing";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
  }
}

function transcriptCardBorder(entries: InkUiEntry[]): "gray" | "red" | "yellow" | "blue" {
  if (entries.some((entry) => entry.kind === "error")) {
    return UI_COLORS.danger;
  }

  if (entries.some((entry) => entry.kind === "warn")) {
    return UI_COLORS.warning;
  }

  if (entries.some((entry) => entry.kind === "tool")) {
    return UI_COLORS.accent;
  }

  if (entries.some((entry) => entry.kind === "info")) {
    return UI_COLORS.accent;
  }

  if (entries.some((entry) => entry.kind === "activity")) {
    return UI_COLORS.muted;
  }

  return UI_COLORS.border;
}
