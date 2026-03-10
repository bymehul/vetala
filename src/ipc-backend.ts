import * as readline from "node:readline";
import { loadConfig, providerConfigFor, withProviderStoredAuth } from "./config.js";
import { Agent, isAgentInterruptedError } from "./agent.js";
import { ApprovalManager } from "./approvals.js";
import { IpcTerminalUI } from "./ipc-ui.js";
import { PathPolicy } from "./path-policy.js";
import { SessionStore } from "./session-store.js";
import { SkillRuntime } from "./skills/runtime.js";
import { createToolRegistry } from "./tools/index.js";
import { detectRuntimeHostProfile } from "./runtime-profile.js";
import type { ApprovalRequest, ApprovalScope, SessionState } from "./types.js";

interface IpcCommand {
    tag: string;
    data?: Record<string, unknown>;
}

async function main(): Promise<void> {
    // Parse workspace from args
    const args = process.argv.slice(2);
    let workspace = process.cwd();
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--workspace" && i + 1 < args.length) {
            workspace = args[i + 1] as string;
        }
    }

    let config = await loadConfig();
    const store = new SessionStore();
    const runtimeProfile = detectRuntimeHostProfile();
    const ui = new IpcTerminalUI(runtimeProfile);

    // Load or create a session
    let session: SessionState;
    try {
        const sessions = await store.listSessions();
        const matching = sessions.find((s) => s.workspaceRoot === workspace);
        if (matching) {
            session = await store.loadSession(matching.id);
        } else {
            session = await store.createSession(workspace, config.defaultProvider, config.defaultModel);
        }
    } catch {
        session = await store.createSession(workspace, config.defaultProvider, config.defaultModel);
    }

    // Send the initial ready message with dashboard data
    ui.sendReady(session);
    ui.sendStatus("Ready");

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

    // Pending approval resolution
    let pendingApprovalResolve: ((scope: ApprovalScope) => void) | null = null;
    const pendingSelects = new Map<string, (index: number) => void>();
    const pendingInputs = new Map<string, (value: string) => void>();

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

    const requestTextInput = (title: string, placeholder: string): Promise<string> => {
        return new Promise<string>((resolve) => {
            const id = Math.random().toString();
            pendingInputs.set(id, resolve);
            ui.sendPromptInput(id, title, placeholder);
        });
    };

    const createTools = () =>
        createToolRegistry({
            includeWebSearch: config.searchProviderName !== "disabled",
            skillRuntime: skills
        });

    let queuedNextPrompt: string | null = null;

    const runPrompt = async (prompt: string, forceRun = false): Promise<void> => {
        const trimmed = prompt.trim();
        if (!trimmed) return;

        // Busy guard: if agent is running, ask user what to do
        if (activeAgent && !forceRun) {
            const choice = await requestSelect(
                `Current turn is still running. What to do with: "${trimmed.slice(0, 60)}"?`,
                ["Send now (stop current turn)", "Send after current turn", "Cancel"]
            );

            if (choice === 0) {
                // Force: interrupt current, then queue to run it
                queuedNextPrompt = trimmed;
                ui.info("Stopping the current turn and sending next prompt.");
                ui.sendStatus("Stopping current turn");
                activeAgent.requestStop();
            } else if (choice === 1) {
                // Queue
                queuedNextPrompt = trimmed;
                ui.info(`Queued next prompt: ${trimmed.slice(0, 80)}`);
                ui.sendStatus("Queued next prompt");
            }
            // else cancel: do nothing
            return;
        }

        // If it's a slash command, handle simply
        if (trimmed.startsWith("/")) {
            await handleCommand(trimmed);
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
            ui
        });
        activeAgent = agent;

        try {
            await agent.runTurn(trimmed, true);
            ui.sendStatus(queuedNextPrompt ? "Running queued prompt" : "Ready");
        } catch (error) {
            if (isAgentInterruptedError(error)) {
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
        const { saveProviderDefaults, saveProviderPersistentAuth, withProviderStoredAuth, withProviderSessionAuth, loadConfig: reloadConfig, providerConfigFor } = await import("./config.js");

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
                ui.sendReady(session);
                ui.sendStatus("Ready");
                return;
            }
            const retIdx = await requestSelect("Keep credential:", [
                "Keep for all sessions until /logout",
                "This session only",
                "Cancel"
            ]);
            if (retIdx === 0) {
                await saveProviderPersistentAuth(session.provider, def.auth.defaultMode, keyVal.trim());
                config = withProviderStoredAuth(nextConfig, session.provider, def.auth.defaultMode, keyVal.trim()) as typeof config;
            } else if (retIdx === 1) {
                config = withProviderSessionAuth(nextConfig, session.provider, def.auth.defaultMode, keyVal.trim()) as typeof config;
            } else {
                ui.warn("API key setup cancelled.");
                ui.sendReady(session);
                ui.sendStatus("Ready");
                return;
            }
        } else {
            config = nextConfig as typeof config;
        }

        ui.info(`Provider set to ${def.label} / ${model}`);
        ui.sendReady(session);
        ui.sendStatus("Ready");
    };

    const handleCommand = async (commandLine: string): Promise<void> => {
        const [command, ...args] = commandLine.slice(1).split(/\s+/);

        switch (command) {
            case "help":
                ui.info([
                    "/help", "/model", "/undo", "/skill", "/tools",
                    "/history", "/resume <session-id>", "/new",
                    "/approve", "/config", "/logout", "/clear", "/exit"
                ].join("\n"));
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
                break;
            case "tools":
                ui.info(
                    createTools()
                        .list()
                        .map((tool) => `${tool.readOnly ? "ro" : "rw"} ${tool.name} - ${tool.description}`)
                        .join("\n")
                );
                break;
            case "config":
                ui.printConfig(config);
                break;
            case "undo": {
                const { undoLastEdit } = await import("./edit-history.js");
                const approvals = new ApprovalManager(session, store, null, requestApprovalDecision);
                const result = await undoLastEdit(session, store, (req) => approvals.requestApproval(req));
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
                break;
            }
            case "resume": {
                if (!args[0]) {
                    const sessions = await store.listSessions();
                    if (sessions.length === 0) { ui.info("(no sessions)"); break; }

                    const items = sessions.slice(0, 10).map(s => `${s.id.slice(0, 8)}  ${s.provider}/${s.model}  ${s.workspaceRoot}`);
                    const idx = await requestSelect("Select session to resume", [...items, "Cancel"]);
                    if (idx < sessions.length) {
                        const s = sessions[idx];
                        if (s) {
                            session = await store.loadSession(s.id);
                            activeAgent = null;
                            ui.sendClear();
                            ui.sendStatus(`Resumed ${session.id.slice(0, 8)}`);
                            ui.sendReady(session);
                        }
                    } else {
                        ui.sendStatus("Ready");
                    }
                    break;
                }
                session = await store.loadSession(args[0]);
                ui.sendClear();
                ui.sendStatus(`Resumed ${session.id.slice(0, 8)}`);
                ui.sendReady(session);
                break;
            }
            case "new": {
                session = await store.createSession(session.workspaceRoot, config.defaultProvider, config.defaultModel);
                ui.sendClear();
                ui.sendStatus(`Created ${session.id.slice(0, 8)}`);
                ui.sendReady(session);
                break;
            }
            case "approve":
                ui.info([
                    `web access: ${session.approvals.webAccess ? "granted" : "not granted"}`,
                    `path grants: ${session.approvals.outOfTreeRoots.join(", ") || "(none)"}`,
                    `session grants: ${session.approvals.sessionActionKeys.join(", ") || "(none)"}`
                ].join("\n"));
                break;
            case "logout": {
                const { clearProviderSavedAuth } = await import("./config.js");
                await clearProviderSavedAuth(session.provider);
                ui.info(`Cleared saved credential for ${session.provider}.`);
                ui.sendStatus("Logged out");
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
                    await runPrompt(cmd.data.text);
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

            case "interrupt":
                activeAgent?.requestStop();
                break;

            case "exit":
                process.exit(0);
        }
    });

    rl.on("close", () => {
        process.exit(0);
    });
}

main().catch((error) => {
    process.stderr.write(`IPC backend error: ${error}\n`);
    process.exit(1);
});
