import * as readline from "node:readline";
import { loadConfig, providerConfigFor, withProviderStoredAuth } from "./config.js";
import { Agent, isAgentInterruptedError } from "./agent.js";
import { ApprovalManager } from "./approvals.js";
import { IpcTerminalUI } from "./ipc-ui.js";
import { PathPolicy } from "./path-policy.js";
import { SessionStore } from "./session-store.js";
import { SkillRuntime } from "./skills/runtime.js";
import { createToolRegistry } from "./tools/index.js";
import { createSearchProvider } from "./search-provider.js";
import { detectRuntimeHostProfile } from "./runtime-profile.js";
import { startMemoriesPipeline } from "./memories/pipeline.js";
import type { ApprovalRequest, ApprovalScope, PersistedMessage, SessionState } from "./types.js";

interface IpcCommand {
    tag: string;
    data?: Record<string, unknown>;
}

async function main(): Promise<void> {
    // Parse workspace from args
    const args = process.argv.slice(2);
    let workspace = process.cwd();
    let resumeSessionId: string | null = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--workspace" && i + 1 < args.length) {
            workspace = args[i + 1] as string;
        }
        if (args[i] === "--session" && i + 1 < args.length) {
            resumeSessionId = args[i + 1] as string;
        }
    }

    let config = await loadConfig();
    const store = new SessionStore();
    const runtimeProfile = detectRuntimeHostProfile();
    const ui = new IpcTerminalUI(runtimeProfile);

    // Load or create a session
    let session: SessionState;
    let isNewSession = false;
    try {
        if (resumeSessionId) {
            session = await store.loadSession(resumeSessionId);
            workspace = session.workspaceRoot;
        } else {
            const summaries = await store.listSessionSummaries(workspace);
            const matching = summaries[0];
            if (matching) {
                session = await store.loadSession(matching.id);
            } else {
                session = await store.createSession(workspace, config.defaultProvider, config.defaultModel);
                isNewSession = true;
            }
        }
    } catch {
        session = await store.createSession(workspace, config.defaultProvider, config.defaultModel);
        isNewSession = true;
    }

    startMemoriesPipeline(config, store);

    const sendReady = (s: SessionState) => {
        const profile = config.providers[s.provider];
        const isLoggedIn = !!(profile && profile.authValue);
        ui.sendReady(s, isLoggedIn);
    };

    const collectResumePreview = (messages: PersistedMessage[], limit: number): PersistedMessage[] => {
        const filtered = messages.filter((message) => {
            if (message.role !== "user" && message.role !== "assistant") {
                return false;
            }
            const content = (message.content ?? "").trim();
            return Boolean(content);
        });
        if (filtered.length <= limit) {
            return filtered;
        }
        return filtered.slice(-limit);
    };

    const sendResumePreview = (s: SessionState): void => {
        const preview = collectResumePreview(s.messages, 6);
        if (preview.length === 0) {
            return;
        }
        ui.sendEntry("info", `Resumed session ${s.id.slice(0, 8)} · showing last ${preview.length} messages`);
        for (const message of preview) {
            ui.sendEntry(message.role as "user" | "assistant", message.content ?? "");
        }
    };

    const skills = new SkillRuntime({
        getSession: () => session,
        sessionStore: store
    });

    // Set up stdin reader for IPC commands from the Haskell TUI
    const rl = readline.createInterface({
        input: process.stdin,
        terminal: false
    });

    let activeAgent: Agent | null = null;
    let lastInterruptedPrompt: string | null = null;

    // Pending approval resolution
    let pendingApprovalResolve: ((scope: ApprovalScope) => void) | null = null;
    const pendingSelects = new Map<string, (index: number) => void>();
    const pendingInputs = new Map<string, (value: string) => void>();
    const pendingDiffs = new Map<string, (diff: string) => void>();
    const pendingSearches = new Map<string, (matches: any[]) => void>();

    const requestApprovalDecision = (request: ApprovalRequest): Promise<ApprovalScope> => {
        return new Promise<ApprovalScope>((resolve) => {
            pendingApprovalResolve = resolve;
            ui.sendApprovalPrompt(request.label);
        });
    };

    const requestSelect = (title: string, options: string[]): Promise<number> => {
        return new Promise<number>((resolve) => {
            const id = Math.random().toString();
            pendingSelects.set(id, resolve);
            ui.sendPromptSelect(id, title, options);
        });
    };

    const formatTimestamp = (value: string): string => {
        if (!value) {
            return value;
        }
        const trimmed = value.replace("T", " ").replace("Z", "");
        return trimmed.length > 16 ? trimmed.slice(0, 16) : trimmed;
    };

    const truncatePreview = (value: string): string => {
        const rawLimit = process.env.VETALA_UI_RESUME_PREVIEW_CHARS;
        const maxChars = rawLimit ? Number(rawLimit) : 0;
        if (!Number.isFinite(maxChars) || maxChars <= 0) {
            return value;
        }
        if (value.length <= maxChars) {
            return value;
        }
        if (maxChars <= 3) {
            return value.slice(0, maxChars);
        }
        return `${value.slice(0, maxChars - 3)}...`;
    };

    const buildResumeIndexMap = (items: Array<{ id: string; createdAt: string }>): Map<string, number> => {
        const sorted = [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        const map = new Map<string, number>();
        sorted.forEach((item, index) => {
            map.set(item.id, index + 1);
        });
        return map;
    };

    const requestTextInput = (title: string, placeholder: string): Promise<string> => {
        return new Promise<string>((resolve) => {
            const id = Math.random().toString();
            pendingInputs.set(id, resolve);
            ui.sendPromptInput(id, title, placeholder);
        });
    };

    const computeDiff = (before: string, after: string): Promise<string | null> => {
        return new Promise((resolve) => {
            const id = Math.random().toString();
            pendingDiffs.set(id, resolve);
            process.stdout.write(JSON.stringify({ tag: "compute_diff", data: { id, before, after } }) + "\n");
        });
    };

    const fastSearch = (query: string, root: string, opts?: { limit?: number; regex?: boolean }): Promise<any[] | null> => {
        return new Promise((resolve) => {
            const id = Math.random().toString();
            pendingSearches.set(id, resolve);
            process.stdout.write(JSON.stringify({
                tag: "fast_search",
                data: {
                    id,
                    query,
                    root,
                    limit: opts?.limit ?? 100,
                    regex: opts?.regex ?? false
                }
            }) + "\n");
        });
    };

    const shouldSkipUpdateCheck = () =>
        process.env.VETALA_UPDATE_CHECKED === "1" || process.env.VETALA_SMOKE_TEST === "1";

    const maybeHandleAppUpdate = async (): Promise<void> => {
        if (shouldSkipUpdateCheck()) {
            return;
        }

        try {
            const { checkForAppUpdate, installAppUpdate, snoozeAppUpdate } = await import("./update-notifier.js");
            const update = await checkForAppUpdate();

            if (!update) {
                return;
            }

            const choice = await requestSelect(
                `Update available: ${update.currentVersion} → ${update.latestVersion}`,
                ["Update now", "Skip for 24 hours"]
            );

            if (choice === 0) {
                ui.info("Installing update...");
                try {
                    const result = await installAppUpdate(update.latestVersion);
                    const output = result.stdout || result.stderr;
                    if (output.trim()) {
                        ui.info(output);
                    }
                    ui.info("Update complete. Restart Vetala to use the new version.");
                } catch (error) {
                    ui.error(`Failed to install update: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                await snoozeAppUpdate(update.latestVersion);
                ui.info("Update skipped for 24 hours.");
            }
        } catch {
            // Best-effort update checks shouldn't block startup.
        }
    };

    const createTools = () =>
        createToolRegistry({
            includeWebSearch: config.searchProviderName !== "disabled",
            skillRuntime: skills
        });

    let queuedNextPrompt: string | null = null;
    let processingPrompt = false;
    const promptQueue: string[] = [];

    const processPromptQueue = async () => {
        if (processingPrompt || promptQueue.length === 0) return;
        processingPrompt = true;
        const prompt = promptQueue.shift()!;
        try {
            await runPrompt(prompt);
        } finally {
            processingPrompt = false;
            void processPromptQueue();
        }
    };

    const resolveContinuation = (input: string): string | null => {
        const normalized = input.trim().toLowerCase();
        if (!lastInterruptedPrompt) {
            return null;
        }
        if (normalized === "continue" || normalized === "resume" || normalized === "go on") {
            return lastInterruptedPrompt;
        }
        return null;
    };

    const runPrompt = async (prompt: string, forceRun = false): Promise<void> => {
        const trimmed = prompt.trim();
        if (!trimmed) return;
        const resumed = resolveContinuation(trimmed);
        const effectivePrompt = resumed ?? trimmed;

        // If it's a slash command, handle immediately even if agent is busy
        if (effectivePrompt.startsWith("/")) {
            await handleCommand(effectivePrompt);
            return;
        }

        // Busy guard: if agent is running, ask user what to do
        if (activeAgent && !forceRun) {
            const choice = await requestSelect(
                `Current turn is still running. What to do with: "${effectivePrompt.slice(0, 60)}"?`,
                ["Send now (stop current turn)", "Send after current turn", "Cancel"]
            );

            if (choice === 0) {
                // Force: interrupt current, then queue to run it
                queuedNextPrompt = effectivePrompt;
                ui.info(resumed ? "Stopping the current turn and resuming the paused request." : "Stopping the current turn and sending next prompt.");
                ui.sendStatus("Stopping current turn");
                activeAgent.requestStop();
            } else if (choice === 1) {
                // Queue
                queuedNextPrompt = effectivePrompt;
                ui.info(resumed ? "Queued resume for the paused request." : `Queued next prompt: ${effectivePrompt.slice(0, 80)}`);
                ui.sendStatus("Queued next prompt");
            }
            // else cancel: do nothing
            return;
        }

        ui.sendStatus("Running agent");

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
            ui,
            requestTextInput,
            requestSelect,
            computeDiff,
            fastSearch
        });
        activeAgent = agent;

        try {
            if (resumed) {
                ui.info(`Resuming: ${effectivePrompt.slice(0, 80)}`);
            }
            await agent.runTurn(effectivePrompt, true);
            ui.sendStatus(queuedNextPrompt ? "Running queued prompt" : "Ready");
            lastInterruptedPrompt = null;
        } catch (error) {
            if (isAgentInterruptedError(error)) {
                lastInterruptedPrompt = effectivePrompt;
                const refinement = await requestTextInput("Agent paused. What should I do differently?", "");
                const refinementTrimmed = refinement.trim();
                if (refinementTrimmed) {
                    const refinedResume = resolveContinuation(refinementTrimmed);
                    if (refinedResume) {
                        queuedNextPrompt = refinedResume;
                    } else {
                        queuedNextPrompt = refinementTrimmed;
                        lastInterruptedPrompt = refinementTrimmed;
                    }
                }
                ui.sendStatus(queuedNextPrompt ? "Running queued prompt" : "Interrupted");
            } else {
                ui.error(error instanceof Error ? error.message : String(error));
                ui.sendStatus("Failed");
            }
        } finally {
            activeAgent = null;
            const next = queuedNextPrompt;
            if (next) {
                queuedNextPrompt = null;
                void runPrompt(next, true);
            }
        }
    };

    const applyModelSelection = async (provider: string, model: string, reasoningEffort: null | "low" | "medium" | "high") => {
        const { getProviderDefinition } = await import("./providers/index.js");
        const {
            saveProviderDefaults,
            saveProviderPersistentAuth,
            saveProviderStoredAuthValue,
            withProviderStoredAuth,
            withProviderSessionAuth,
            loadConfig: reloadConfig,
            providerConfigFor
        } = await import("./config.js");

        const def = getProviderDefinition(provider as any);
        await store.updateModel(session, provider as any, model);
        await saveProviderDefaults(provider as any, model, def.supportsReasoningEffort ? { reasoningEffort } : {});
        session.provider = provider as any;
        session.model = model;

        const nextConfig = await reloadConfig();
        const nextProfile = providerConfigFor(nextConfig, session.provider);

        if (nextProfile.authSource === "missing" || nextProfile.authSource === "stored_hash") {
            const authLabel = def.auth.inputLabel;
            const keyVal = await requestTextInput(`Enter ${authLabel} for ${def.label} / ${model}`, "");
            if (!keyVal.trim()) {
                ui.warn(`Credential entry cancelled. Model settings saved, but no usable ${def.label} credential is active.`);
                sendReady(session);
                ui.sendStatus("Ready");
                return;
            }
            const retIdx = await requestSelect("Keep credential:", [
                "All sessions (until /logout)",
                "Store hash only (re-enter next session)",
                "This session only",
                "Cancel"
            ]);
            if (retIdx === 0) {
                await saveProviderStoredAuthValue(session.provider, def.auth.defaultMode, keyVal.trim());
                config = withProviderStoredAuth(nextConfig, session.provider, def.auth.defaultMode, keyVal.trim()) as typeof config;
            } else if (retIdx === 1) {
                await saveProviderPersistentAuth(session.provider, def.auth.defaultMode, keyVal.trim());
                config = withProviderSessionAuth(nextConfig, session.provider, def.auth.defaultMode, keyVal.trim()) as typeof config;
            } else if (retIdx === 2) {
                config = withProviderSessionAuth(nextConfig, session.provider, def.auth.defaultMode, keyVal.trim()) as typeof config;
            } else {
                ui.warn("API key setup cancelled.");
                sendReady(session);
                ui.sendStatus("Ready");
                return;
            }
        } else {
            config = nextConfig as typeof config;
        }

        ui.info(`Provider set to ${def.label} / ${model}`);
        sendReady(session);
        ui.sendStatus("Ready");
    };

    const handleCommand = async (commandLine: string): Promise<void> => {
        const [command, ...args] = commandLine.slice(1).split(/\s+/);

        switch (command) {
            case "help":
                ui.info([
                    "/help", "/model", "/undo", "/skill", "/tools",
                    "/history", "/resume [latest|index|id]", "/resume list", "/new",
                    "/approve", "/config", "/logout", "/clear", "/exit"
                ].join("\n"));
                ui.sendStatus("Ready");
                break;
            case "clear":
                ui.sendClear();
                ui.sendStatus("Ready");
                break;
            case "history":
                ui.info(
                    session.messages
                        .slice(-20)
                        .map((msg) => {
                            const label = msg.role.padEnd(9, " ");
                            const content = (msg.content ?? "[tool call]").replace(/\s+/g, " ").slice(0, 140);
                            return `${label} ${content}`;
                        })
                        .join("\n") || "(empty session)"
                );
                ui.sendStatus("Ready");
                break;
            case "tools":
                ui.info(
                    createTools()
                        .list()
                        .map((tool) => `${tool.readOnly ? "ro" : "rw"} ${tool.name} - ${tool.description}`)
                        .join("\n")
                );
                ui.sendStatus("Ready");
                break;
            case "config":
                ui.printConfig(config);
                ui.sendStatus("Ready");
                break;
            case "undo": {
                const { undoLastEdit } = await import("./edit-history.js");
                const approvals = new ApprovalManager(session, store, null, requestApprovalDecision);
                // Create a temporary tool context for the undo command
                const context = {
                    cwd: process.cwd(),
                    workspaceRoot: session.workspaceRoot,
                    approvals: {
                        requestApproval: (request: ApprovalRequest) => approvals.requestApproval(request),
                        hasSessionGrant: (key: string) => approvals.hasSessionGrant(key),
                        registerReference: (targetPath: string) => store.appendReference(session, targetPath),
                        ensureWebAccess: () => approvals.ensureWebAccess()
                    },
                    interaction: {
                        askText: (prompt: string, placeholder = "") => requestTextInput(prompt, placeholder),
                        askSelect: (prompt: string, options: string[]) => requestSelect(prompt, options)
                    },
                    performance: {
                        computeDiff,
                        fastSearch
                    },
                    reads: {
                        hasRead: (targetPath: string) => session.readFiles.includes(targetPath),
                        registerRead: (targetPath: string) => store.appendReadFile(session, targetPath)
                    },
                    edits: {
                        recordEdit: (edit: any) => store.appendEdit(session, edit)
                    },
                    paths: {
                        resolve: (inputPath: string) => new PathPolicy(session.workspaceRoot, approvals).resolve(inputPath),
                        ensureReadable: (inputPath: string) => new PathPolicy(session.workspaceRoot, approvals).ensureReadable(inputPath),
                        ensureWritable: (inputPath: string) => new PathPolicy(session.workspaceRoot, approvals).ensureWritable(inputPath),
                        allowedRoots: () => new PathPolicy(session.workspaceRoot, approvals).allowedRoots()
                    },
                    searchProvider: createSearchProvider(config.searchProviderName)
                };
                const result = await undoLastEdit(session, store, (req) => approvals.requestApproval(req), context);
                ui.info(result.content);
                ui.sendStatus(result.isError ? "Undo blocked" : "Ready");
                break;
            }
            case "skill":
            case "skills": {
                if (args.length === 0) {
                    const available = await skills.listSkills();
                    const pinned = new Set((await skills.pinnedSkills()).map((s) => s.name));
                    ui.info(
                        available.length > 0
                            ? available.map((s) => `${pinned.has(s.name) ? "*" : "-"} ${s.name} - ${s.description}`).join("\n")
                            : "(no skills available)"
                    );
                    ui.sendStatus("Ready");
                    break;
                }
                const [sub, ...rest] = args;
                if (sub === "use" || sub === "pin") {
                    if (!rest[0]) { ui.warn("Usage: /skill use <name>"); break; }
                    const skill = await skills.pinSkill(rest[0]);
                    ui.info(`Pinned skill: ${skill.name}`);
                } else if (sub === "drop" || sub === "unpin") {
                    if (!rest[0]) { ui.warn("Usage: /skill drop <name>"); break; }
                    const skill = await skills.unpinSkill(rest[0]);
                    ui.info(`Unpinned skill: ${skill.name}`);
                } else if (sub === "clear") {
                    const cleared = await skills.clearPinnedSkills();
                    ui.info(`Cleared ${cleared} pinned skills.`);
                }
                ui.sendStatus("Ready");
                break;
            }
            case "resume": {
                const selector = args[0];
                if (selector === "list") {
                    const sessions = await store.listSessionSummaries(session.workspaceRoot);
                    if (sessions.length === 0) {
                        ui.info("(no sessions for this workspace)");
                    } else {
                        const indexMap = buildResumeIndexMap(sessions);
                        const lines = sessions.map((item) => {
                            const idx = indexMap.get(item.id) ?? 0;
                            const preview = truncatePreview(item.preview || "(empty session)");
                            const updated = formatTimestamp(item.updatedAt);
                            return `#${idx} ${preview} · ${item.provider}/${item.model} · ${updated}`;
                        });
                        ui.info(lines.join("\n"));
                    }
                    ui.sendStatus("Ready");
                    break;
                }

                if (!selector) {
                    const sessions = await store.listSessionSummaries(session.workspaceRoot);
                    if (sessions.length === 0) { ui.info("(no sessions for this workspace)"); ui.sendStatus("Ready"); break; }

                    const indexMap = buildResumeIndexMap(sessions);
                    const maxItems = 20;
                    const sessionsToShow = sessions.slice(0, maxItems);
                    const items = sessionsToShow.map((item) => {
                        const idx = indexMap.get(item.id) ?? 0;
                        const preview = truncatePreview(item.preview || "(empty session)");
                        const updated = formatTimestamp(item.updatedAt);
                        return `(${idx}) ${preview} · ${item.provider}/${item.model} · ${updated}`;
                    });
                    const idx = await requestSelect("Select session to resume", [...items, "Cancel"]);
                    if (idx < sessionsToShow.length) {
                        const s = sessionsToShow[idx];
                        if (s) {
                            session = await store.loadSession(s.id);
                            activeAgent = null;
                            ui.sendClear();
                            ui.sendStatus(`Resumed ${session.id.slice(0, 8)}`);
                            sendReady(session);
                            sendResumePreview(session);
                            ui.sendStatus("Ready");
                        }
                    } else {
                        ui.sendStatus("Ready");
                    }
                    break;
                }

                const resolved = await store.resolveResumeSelection(session.workspaceRoot, selector);
                if (resolved.status === "empty") {
                    ui.warn("No sessions available for this workspace.");
                } else if (resolved.status === "not_found") {
                    ui.warn(`No session found for selector "${selector}".`);
                } else if (resolved.status === "ambiguous") {
                    ui.warn(`Selector "${selector}" matched multiple sessions. Use a longer id prefix.`);
                } else {
                    session = resolved.session;
                    activeAgent = null;
                    ui.sendClear();
                    ui.sendStatus(`Resumed ${session.id.slice(0, 8)}`);
                    sendReady(session);
                    sendResumePreview(session);
                }
                ui.sendStatus("Ready");
                break;
            }
            case "new": {
                session = await store.createSession(session.workspaceRoot, config.defaultProvider, config.defaultModel);
                ui.sendClear();
                ui.sendStatus(`Created ${session.id.slice(0, 8)}`);
                sendReady(session);
                break;
            }
            case "approve":
                ui.info([
                    `web access: ${session.approvals.webAccess ? "granted" : "not granted"}`,
                    `path grants: ${session.approvals.outOfTreeRoots.join(", ") || "(none)"}`,
                    `session grants: ${session.approvals.sessionActionKeys.join(", ") || "(none)"}`
                ].join("\n"));
                ui.sendStatus("Ready");
                break;
            case "logout": {
                activeAgent?.requestStop();
                const { clearProviderSavedAuth } = await import("./config.js");
                await clearProviderSavedAuth(session.provider);
                ui.info(`Cleared saved credential for ${session.provider}.`);
                sendReady(session);
                ui.sendStatus("Ready");
                break;
            }
            case "exit": {
                activeAgent?.requestStop();
                process.exit(0);
                break;
            }
            case "model": {
                const { listProviders, getProviderDefinition } = await import("./providers/index.js");
                const providers = listProviders();
                const items = [...providers.map((p: any) => p.name === session.provider ? `${p.label} (current)` : p.label), "Cancel"];
                const pIdx = await requestSelect("Select provider", items);

                if (pIdx >= providers.length || pIdx < 0) { ui.sendStatus("Ready"); break; }
                const nextProvider = providers[pIdx]!.name;

                const def = getProviderDefinition(nextProvider as any);
                let nextModel = nextProvider === session.provider ? session.model : def.defaultModel;

                if (nextProvider === "sarvam") {
                    const smodels = [...def.suggestedModels, "Cancel"];
                    const mIdx = await requestSelect("Select Sarvam model", smodels);
                    if (mIdx >= def.suggestedModels.length) { ui.sendStatus("Ready"); break; }
                    nextModel = def.suggestedModels[mIdx] as string;
                } else if (nextProvider === "openrouter") {
                    const mName = await requestTextInput("Enter OpenRouter model id", nextModel);
                    if (!mName.trim()) { ui.sendStatus("Ready"); break; }
                    nextModel = mName.trim();
                } else {
                    const mName = await requestTextInput(`Enter model for ${def.label}`, nextModel);
                    if (!mName.trim()) { ui.sendStatus("Ready"); break; }
                    nextModel = mName.trim();
                }

                let nextReasoning: null | "low" | "medium" | "high" = null;
                if (def.supportsReasoningEffort) {
                    const rItems = ["None", "Low", "Medium", "High", "Cancel"];
                    const vals = [null, "low", "medium", "high", null];
                    const rIdx = await requestSelect("Select reasoning effort", rItems);
                    if (rIdx >= 4) { ui.sendStatus("Ready"); break; }
                    nextReasoning = vals[rIdx] as any;
                }

                await applyModelSelection(nextProvider, nextModel, nextReasoning);
                break;
            }
            default:
                ui.warn(`Unknown command: /${command}`);
        }
    };

    // Listen for JSON commands from the Haskell TUI
    rl.on("line", async (line: string) => {
        let cmd: IpcCommand;
        try {
            cmd = JSON.parse(line);
        } catch {
            return; // Skip malformed lines
        }

        switch (cmd.tag) {
            case "input":
                if (cmd.data?.text && typeof cmd.data.text === "string") {
                    promptQueue.push(cmd.data.text);
                    void processPromptQueue();
                }
                break;

            case "trust":
                // Trust acknowledged, nothing to do on backend side
                break;

            case "approval":
                if (pendingApprovalResolve && cmd.data?.scope) {
                    const scope = cmd.data.scope as ApprovalScope;
                    const resolve = pendingApprovalResolve;
                    pendingApprovalResolve = null;
                    resolve(scope);
                }
                break;

            case "submitSelect":
                if (cmd.data?.id && typeof cmd.data.index === "number") {
                    const id = cmd.data.id as string;
                    const resolve = pendingSelects.get(id);
                    if (resolve) {
                        pendingSelects.delete(id);
                        resolve(cmd.data.index);
                    }
                }
                break;

            case "submitInput":
                if (cmd.data?.id && typeof cmd.data.value === "string") {
                    const id = cmd.data.id as string;
                    const resolve = pendingInputs.get(id);
                    if (resolve) {
                        pendingInputs.delete(id);
                        resolve(cmd.data.value);
                    }
                }
                break;

            case "diffResult":
                if (cmd.data?.id && typeof cmd.data.diff === "string") {
                    const id = cmd.data.id as string;
                    const resolve = pendingDiffs.get(id);
                    if (resolve) {
                        pendingDiffs.delete(id);
                        resolve(cmd.data.diff);
                    }
                }
                break;

            case "searchResult":
                if (cmd.data?.id && Array.isArray(cmd.data.matches)) {
                    const id = cmd.data.id as string;
                    const resolve = pendingSearches.get(id);
                    if (resolve) {
                        pendingSearches.delete(id);
                        resolve(cmd.data.matches);
                    }
                }
                break;

            case "interrupt":
                activeAgent?.requestStop();
                break;

            case "exit":
                process.exit(0);
        }
    });

    await maybeHandleAppUpdate();

    // Send the initial ready message with dashboard data
    sendReady(session);
    if (!isNewSession) {
        sendResumePreview(session);
    }
    ui.sendStatus("Ready");

    rl.on("close", () => {
        process.exit(0);
    });
}

main().catch((error) => {
    process.stderr.write(`IPC backend error: ${error}\n`);
    process.exit(1);
});
