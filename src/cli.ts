#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { Agent } from "./agent.js";
import { ApprovalManager } from "./approvals.js";
import { loadConfig } from "./config.js";
import { PathPolicy } from "./path-policy.js";
import { SessionStore } from "./session-store.js";
import { SkillRuntime } from "./skills/runtime.js";
import { TerminalUI } from "./terminal-ui.js";
import { createToolRegistry } from "./tools/index.js";
import type { SessionState } from "./types.js";
import { ensureWorkspaceTrust } from "./workspace-trust.js";

const program = new Command();

program
  .name("vetala")
  .description("Sarvam-powered coding CLI.")
  .option("-p, --prompt <prompt>", "Run a single prompt and exit")
  .option("--new", "Start a fresh session")
  .option("--resume <sessionId>", "Resume a specific session")
  .option("--model <model>", "Override the model for this run")
  .action(async (options) => {
    let config = await loadConfig();
    const ui = new TerminalUI();
    const store = new SessionStore();
    const workspaceRoot = process.cwd();
    let session = await resolveSession(store, workspaceRoot, config.defaultModel, options);

    if (session.workspaceRoot !== process.cwd()) {
      process.chdir(session.workspaceRoot);
    }

    if (options.model && options.model !== session.model) {
      await store.updateModel(session, options.model);
    }

    if (options.prompt) {
      const trustedConfig = await ensureWorkspaceTrust(session.workspaceRoot, config, ui);

      if (!trustedConfig) {
        process.exitCode = 1;
        return;
      }

      config = trustedConfig;
      await runOneShot(options.prompt, session, config, store, ui);
      return;
    }

    const { startRepl } = await import("./repl.js");
    await startRepl(session, { ui, store });
  });

await program.parseAsync(process.argv);

async function resolveSession(
  store: SessionStore,
  workspaceRoot: string,
  defaultModel: string,
  options: { new?: boolean; resume?: string }
): Promise<SessionState> {
  if (options.resume) {
    return store.loadSession(options.resume);
  }

  return store.createSession(workspaceRoot, defaultModel);
}

async function runOneShot(
  prompt: string,
  session: SessionState,
  config: Awaited<ReturnType<typeof loadConfig>>,
  store: SessionStore,
  ui: TerminalUI
): Promise<void> {
  const rl = stdin.isTTY
    ? readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: true
      })
    : null;

  try {
    const approvals = new ApprovalManager(session, store, rl ? (question) => rl.question(`${question} `) : null);
    const skills = new SkillRuntime({
      getSession: () => session,
      sessionStore: store
    });
    const agent = new Agent({
      config,
      session,
      sessionStore: store,
      approvals,
      pathPolicy: new PathPolicy(session.workspaceRoot, approvals),
      skills,
      tools: createToolRegistry({
        includeWebSearch: config.searchProviderName !== "disabled",
        skillRuntime: skills
      }),
      ui
    });

    await agent.runTurn(prompt, stdout.isTTY);
  } finally {
    await rl?.close();
  }
}
