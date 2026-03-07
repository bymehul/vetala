import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { Agent } from "../agent.js";
import { ApprovalManager } from "../approvals.js";
import {
  clearSavedAuth,
  loadConfig,
  saveChatDefaults,
  savePersistentAuth,
  withSessionAuth,
  withStoredAuth
} from "../config.js";
import { PathPolicy } from "../path-policy.js";
import { SessionStore } from "../session-store.js";
import { SARVAM_MODELS } from "../sarvam/models.js";
import { SkillRuntime } from "../skills/runtime.js";
import type { SkillCatalogEntry } from "../skills/types.js";
import { createToolRegistry } from "../tools/index.js";
import type {
  ApprovalRequest,
  ApprovalScope,
  EffectiveConfig,
  ReasoningEffort,
  SessionListItem,
  SessionState
} from "../types.js";
import { InkTerminalUI, type InkEntryKind, type InkUiEntry } from "./ink-terminal-ui.js";
import { buildSlashSuggestions } from "./command-suggestions.js";
import { buildTranscriptCards } from "./transcript-cards.js";

interface ReplAppProps {
  initialConfig: EffectiveConfig;
  initialSession: SessionState;
  store: SessionStore;
}

interface ApprovalPromptState {
  request: ApprovalRequest;
  resolve: (scope: ApprovalScope) => void;
}

interface AuthInputState {
  model: string;
  reasoningEffort: ReasoningEffort | null;
  authMode: "bearer" | "subscription_key";
  value: string;
}

type AuthRetentionChoice = "persist" | "session" | "cancel";
type ReasoningEffortChoice = ReasoningEffort | "none" | "cancel";

interface ModelSetupState {
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

export function ReplApp({ initialConfig, initialSession, store }: ReplAppProps) {
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingReasoningSetup, setPendingReasoningSetup] = useState<ModelSetupState | null>(null);
  const [pendingAuthInput, setPendingAuthInput] = useState<AuthInputState | null>(null);
  const [pendingAuthRetention, setPendingAuthRetention] = useState<AuthInputState | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [pendingExitConfirm, setPendingExitConfirm] = useState(false);
  const assistantBufferRef = useRef("");
  const nextEntryIdRef = useRef(0);
  const sessionRef = useRef(session);
  const uiRef = useRef<InkTerminalUI | null>(null);
  const skillRuntimeRef = useRef<SkillRuntime | null>(null);

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

  const finalizeAssistant = () => {
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
        setAssistantBuffer(assistantBufferRef.current);
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
    });
  }

  const ui = uiRef.current;
  if (!skillRuntimeRef.current) {
    skillRuntimeRef.current = new SkillRuntime({
      getSession: () => sessionRef.current,
      sessionStore: store
    });
  }
  const skills = skillRuntimeRef.current;
  const busy = spinnerLabel !== null;
  const transcriptCards = buildTranscriptCards(entries).slice(-8);
  const liveCardId = transcriptCards.at(-1)?.id ?? null;
  const visibleStatus = paused ? "Paused" : status;
  const slashSuggestions = buildSlashSuggestions(input, availableSkills).slice(0, 8);
  const showSlashSuggestions = Boolean(
    trusted &&
    !busy &&
    !paused &&
    !pendingExitConfirm &&
    !pendingApproval &&
    !modelPickerOpen &&
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
    assistantBufferRef.current = "";
    setAssistantBuffer("");
    setActivityLabel(null);
    nextEntryIdRef.current = 0;
    setEntries([]);
  };

  const mergeLoadedConfig = (loaded: EffectiveConfig): EffectiveConfig => {
    if (config.authSource === "session" && config.authValue) {
      return {
        ...loaded,
        authMode: config.authMode,
        authValue: config.authValue,
        authFingerprint: config.authFingerprint,
        authSource: "session"
      };
    }

    return loaded;
  };

  const closeCommandModals = () => {
    setModelPickerOpen(false);
    setPendingReasoningSetup(null);
    setPendingAuthInput(null);
    setPendingAuthRetention(null);
  };

  const runPrompt = async (prompt: string) => {
    const trimmed = prompt.trim();

    if (!trimmed) {
      return;
    }

    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed);
      return;
    }

    setInput("");
    setPendingExitConfirm(false);
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
      skills,
      tools: createTools(),
      ui
    });

    try {
      await agent.runTurn(trimmed, true);
      syncSession(session);
      setActivityLabel(null);
      setStatus("Ready");
    } catch (error) {
      finalizeAssistant();
      setActivityLabel(null);
      pushEntry("error", error instanceof Error ? error.message : String(error));
      setStatus("Failed");
      syncSession(session);
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
        setStatus("Select a model");
        return;
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
        const nextSession = await store.createSession(session.workspaceRoot, session.model);
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
        const previousAuthSource = config.authSource;
        await clearSavedAuth();
        closeCommandModals();

        const reloaded = await loadConfig();
        setConfig(reloaded);

        if (reloaded.authSource === "env") {
          pushEntry(
            "warn",
            "Cleared local auth state, but environment credentials are still active for this process."
          );
        } else if (previousAuthSource === "stored" || previousAuthSource === "stored_hash") {
          pushEntry("info", "Cleared the saved API key for future launches and removed current local auth.");
        } else if (previousAuthSource === "session") {
          pushEntry("info", "Cleared the API key that was only active in this session.");
        } else {
          pushEntry("info", "No saved API key remained after logout.");
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

  const onModelSelect = async (
    value: (typeof SARVAM_MODELS)[number] | "cancel"
  ) => {
    if (value === "cancel") {
      setModelPickerOpen(false);
      setStatus("Ready");
      return;
    }

    setModelPickerOpen(false);
    setPendingReasoningSetup({
      model: value,
      reasoningEffort: config.reasoningEffort
    });
    setStatus(`Select reasoning effort for ${value}`);
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

    await store.updateModel(session, nextSettings.model);
    await saveChatDefaults(nextSettings.model, nextSettings.reasoningEffort);
    syncSession(session);

    const loadedConfig = await loadConfig();
    const nextConfig = mergeLoadedConfig(loadedConfig);
    setConfig(nextConfig);

    if (nextConfig.authSource === "missing" || nextConfig.authSource === "stored_hash") {
      setPendingAuthInput({
        ...nextSettings,
        authMode: "subscription_key",
        value: ""
      });
      setStatus(`Enter API key for ${nextSettings.model}`);
      return;
    }

    pushEntry("info", formatModelSetupSummary(nextSettings, nextConfig));
    setStatus("Ready");
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
        "API key entry cancelled. Model settings were saved, but no usable Sarvam credential is active."
      );
      setStatus("Ready");
      return;
    }

    setPendingAuthInput(null);
    setPendingAuthRetention({
      ...current,
      value: trimmed
    });
    setStatus("Choose how long to keep this API key");
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
        ? withStoredAuth(loadedConfig, current.authMode, current.value)
        : withSessionAuth(loadedConfig, current.authMode, current.value);

    if (choice === "persist") {
      await savePersistentAuth(current.authMode, current.value);
    }

    setConfig(nextConfig);
    setPendingAuthRetention(null);
    pushEntry("info", formatModelSetupSummary(current, nextConfig, choice));

    if (choice === "persist" && loadedConfig.authSource === "env") {
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
            {transcriptCards.length === 0 && !assistantBuffer && !spinnerLabel ? (
              <Box borderStyle="round" borderColor="gray" paddingX={1}>
                <Text color="gray">New transcript. Use /history if you want earlier session messages.</Text>
              </Box>
            ) : null}

            {transcriptCards.map((card) => (
              <TranscriptCard
                key={card.id}
                card={card}
                assistantBuffer={card.id === liveCardId ? assistantBuffer : ""}
                liveLabel={card.id === liveCardId ? activityLabel ?? spinnerLabel : null}
              />
            ))}

            {transcriptCards.length === 0 && (assistantBuffer || activityLabel || spinnerLabel) ? (
              <LiveStatusCard
                assistantBuffer={assistantBuffer}
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
          ) : modelPickerOpen ? (
            <ModelPicker currentModel={session.model} onSelect={onModelSelect} />
          ) : pendingReasoningSetup ? (
            <ReasoningEffortPicker
              currentValue={pendingReasoningSetup.reasoningEffort}
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
                busy={busy}
                value={input}
                onChange={setInput}
                onSubmit={runPrompt}
              />
              {showSlashSuggestions ? <SlashSuggestionBox suggestions={slashSuggestions} /> : null}
            </>
          )}

          <Footer config={config} status={visibleStatus} session={session} />
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
  const infoRows = [
    { item: "model", value: session.model },
    { item: "directory", value: session.workspaceRoot },
    { item: "session", value: session.id.slice(0, 8) },
    { item: "updated", value: formatTimestamp(session.updatedAt) }
  ];

  const stateRows = [
    { item: "auth", value: describeAuth(config) },
    { item: "reasoning", value: formatReasoningEffort(config.reasoningEffort) },
    { item: "skills", value: describeSkills(session.pinnedSkills.length) },
    { item: "sha256", value: config.authFingerprint?.slice(0, 12) ?? "(none)" },
    { item: "context", value: describeContext(session.messages.length) }
  ];

  return (
    <>
      <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="row">
        <Box flexDirection="column" width="60%" paddingRight={2}>
          <Text color="yellow">Vetala</Text>
          <Text bold>Ready.</Text>
          <Box marginTop={1} flexDirection="column">
            {infoRows.map((row) => (
              <InfoRow key={row.item} item={row.item} value={row.value} />
            ))}
          </Box>
        </Box>

        <Box flexDirection="column" width="40%">
          <Text color="yellow">Tips</Text>
          <Text>/help for commands</Text>
          <Text>/model for model + reasoning</Text>
          <Text>/skill to inspect local skills</Text>
          <Text>/logout to clear local auth</Text>
          <Text>Ctrl+C to pause</Text>
          <Text>Ctrl+D to exit</Text>
          <Box marginTop={1}>
            <Text color="gray">status: {status}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="yellow">Context</Text>
          </Box>
          {stateRows.map((row) => (
            <InfoRow key={row.item} item={row.item} value={row.value} />
          ))}
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>Try "explain this codebase" or "write a test for &lt;filepath&gt;"</Text>
      </Box>
    </>
  );
}

function InfoRow({ item, value }: { item: string; value: string }) {
  return (
    <Box>
      <Box width={12}>
        <Text color="gray">{item}</Text>
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
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow">Accessing workspace</Text>
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
    <Box marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
      <Text color="magenta">Approval required</Text>
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
  currentModel,
  onSelect
}: {
  currentModel: string;
  onSelect: (value: (typeof SARVAM_MODELS)[number] | "cancel") => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
      <Text color="green">Select model</Text>
      <Text color="gray">Current: {currentModel}</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            ...SARVAM_MODELS.map((model) => ({
              label: model === currentModel ? `${model} (current)` : model,
              value: model
            })),
            { label: "Cancel", value: "cancel" as const }
          ]}
          onSelect={(item) => void onSelect(item.value)}
        />
      </Box>
    </Box>
  );
}

function ReasoningEffortPicker({
  currentValue,
  model,
  onSelect
}: {
  currentValue: ReasoningEffort | null;
  model: string;
  onSelect: (value: ReasoningEffortChoice) => Promise<void>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
      <Text color="green">Select reasoning effort</Text>
      <Text color="gray">
        Model: {model} · Current: {formatReasoningEffort(currentValue)}
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
  return (
    <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
      <Text color="green">Enter API key for {state.model}</Text>
      <Text color="gray">
        This will be used as Sarvam&apos;s `apiSubscriptionKey`. After you press Enter, choose whether
        Vetala keeps it for all sessions or only for this session.
      </Text>
      <Text color="gray">Reasoning: {formatReasoningEffort(state.reasoningEffort)}</Text>
      <Text color="gray">Press Enter on an empty field to cancel.</Text>
      <Box marginTop={1}>
        <Text color="cyan">key </Text>
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
    <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
      <Text color="green">Keep API key for {state.model}</Text>
      <Text color="gray">Key preview: {maskSecretPreview(state.value)}</Text>
      <Text color="gray">Reasoning: {formatReasoningEffort(state.reasoningEffort)}</Text>
      <Text color="gray">Future-session mode stores the raw key locally until you run /logout.</Text>
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
    <Box marginTop={1} borderStyle="round" borderColor="white" paddingX={1}>
      <Text color="cyan">❯ </Text>
      {busy ? (
        <Text color="gray">Agent is busy. Wait for the current turn to finish.</Text>
      ) : (
        <TextInput
          highlightPastedText={false}
          value={value}
          onChange={onChange}
          onSubmit={(nextValue) => void onSubmit(nextValue)}
        />
      )}
    </Box>
  );
}

function SlashSuggestionBox({
  suggestions
}: {
  suggestions: ReturnType<typeof buildSlashSuggestions>;
}) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
      <Text color="blue">Commands</Text>
      <Text color="gray">Tab autocompletes the first match.</Text>
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.label}>
          <Box width="45%">
            <Text color={index === 0 ? "cyan" : "white"}>
              {index === 0 ? "❯ " : "  "}
              {suggestion.label}
            </Text>
          </Box>
          <Text color="gray">{suggestion.detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

function PauseBox() {
  return (
    <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow">Paused</Text>
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
      <Text color="gray">Current session state is already written to disk as it changes.</Text>
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
  status,
  session
}: {
  config: EffectiveConfig;
  status: string;
  session: SessionState;
}) {
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Text color="gray">/help for commands · Ctrl+C pause · Ctrl+D exit</Text>
      <Text color="gray">
        {status} · {describeAuth(config)} · {describeContext(session.messages.length)}
      </Text>
    </Box>
  );
}

function TranscriptCard({
  card,
  assistantBuffer,
  liveLabel
}: {
  card: ReturnType<typeof buildTranscriptCards>[number];
  assistantBuffer: string;
  liveLabel: string | null;
}) {
  const borderColor = transcriptCardBorder(card.entries);

  return (
    <Box marginBottom={1} borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {card.entries.map((entry) => (
        <TranscriptSection key={entry.id} entry={entry} />
      ))}
      {liveLabel ? <LiveActivitySection label={liveLabel} /> : null}
      {assistantBuffer ? (
        <TranscriptSection entry={{ id: `${card.id}:stream`, kind: "assistant", text: assistantBuffer }} />
      ) : null}
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
    <Box marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      {liveLabel ? <LiveActivitySection label={liveLabel} /> : null}
      {assistantBuffer ? (
        <TranscriptSection entry={{ id: "live:assistant", kind: "assistant", text: assistantBuffer }} />
      ) : null}
    </Box>
  );
}

function TranscriptSection({ entry }: { entry: InkUiEntry }) {
  const isActivity = entry.kind === "activity";

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text color={entryColor(entry.kind)}>{entryLabel(entry.kind)}</Text>
      {entry.text.split("\n").map((line, index) =>
        isActivity ? (
          <Text key={`${entry.id}:${index}`} color="gray">
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
      <Text color="gray">doing</Text>
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="gray"> {label}</Text>
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
    pinnedSkills: [...session.pinnedSkills]
  };
}

function formatSessionList(sessions: SessionListItem[]): string {
  return sessions.length > 0
    ? sessions
        .slice(0, 10)
        .map((item) => `${item.id}  ${item.updatedAt}  ${item.workspaceRoot}`)
        .join("\n")
    : "(no sessions)";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function describeAuth(config: EffectiveConfig): string {
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

function formatReasoningEffort(value: ReasoningEffort | null): string {
  return value ?? "(none)";
}

function describeSkills(pinnedCount: number): string {
  return pinnedCount > 0 ? `${pinnedCount} pinned` : "none pinned";
}

function formatModelSetupSummary(
  state: Pick<AuthInputState, "model" | "reasoningEffort">,
  config: EffectiveConfig,
  authRetention?: Exclude<AuthRetentionChoice, "cancel">
): string {
  const lines = [
    `Model: ${state.model}`,
    `Reasoning effort: ${formatReasoningEffort(state.reasoningEffort)}`,
    `Credential: ${describeAuth(config)}`,
    `Stored SHA-256: ${config.authFingerprint?.slice(0, 16) ?? "(none)"}`
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
      return "cyan";
    case "user":
      return "green";
    case "tool":
      return "magenta";
    case "activity":
      return "gray";
    case "info":
      return "blue";
    case "warn":
      return "yellow";
    case "error":
      return "red";
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

function transcriptCardBorder(entries: InkUiEntry[]): "white" | "red" | "yellow" | "magenta" | "blue" | "cyan" | "gray" {
  if (entries.some((entry) => entry.kind === "error")) {
    return "red";
  }

  if (entries.some((entry) => entry.kind === "warn")) {
    return "yellow";
  }

  if (entries.some((entry) => entry.kind === "tool")) {
    return "magenta";
  }

  if (entries.some((entry) => entry.kind === "assistant")) {
    return "white";
  }

  if (entries.some((entry) => entry.kind === "info")) {
    return "blue";
  }

  if (entries.some((entry) => entry.kind === "activity")) {
    return "gray";
  }

  return "white";
}
