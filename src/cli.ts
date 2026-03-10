#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { Agent } from "./agent.js";
import { ApprovalManager } from "./approvals.js";
import { APP_VERSION } from "./app-meta.js";
import { loadConfig } from "./config.js";
import { PathPolicy } from "./path-policy.js";
import { resolveProviderName } from "./providers/index.js";
import { detectRuntimeHostProfile } from "./runtime-profile.js";
import { SessionStore } from "./session-store.js";
import { SkillRuntime } from "./skills/runtime.js";
import { TerminalUI } from "./terminal-ui.js";
import { createToolRegistry } from "./tools/index.js";
import type { ProviderName, SessionState } from "./types.js";
import { ensureWorkspaceTrust } from "./workspace-trust.js";

const program = new Command();

program
  .name("vetala")
  .version(APP_VERSION)
  .description("Multi-provider coding CLI.")
  .option("-p, --prompt <prompt>", "Run a single prompt and exit")
  .option("--new", "Start a fresh session")
  .option("--resume <sessionId>", "Resume a specific session")
  .option("--provider <provider>", "Override the provider for this run")
  .option("--model <model>", "Override the model for this run")
  .action(async (options) => {
    const { spawn } = await import("node:child_process");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { default: updateNotifier } = await import("update-notifier");

    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const isDist = __dirname.includes("dist");
    const projectRoot = join(__dirname, isDist ? "../../" : "../");
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));

    updateNotifier({ pkg }).notify();

    let config = await loadConfig();
    const runtimeProfile = detectRuntimeHostProfile();
    const ui = new TerminalUI(runtimeProfile);
    const store = new SessionStore();
    const workspaceRoot = process.cwd();
    let session = await resolveSession(store, workspaceRoot, config.defaultProvider, config.defaultModel, options);

    if (session.workspaceRoot !== process.cwd()) {
      process.chdir(session.workspaceRoot);
    }

    const overrideProvider = resolveProviderOption(options.provider);
    if (options.provider && !overrideProvider) {
      throw new Error(`Unknown provider: ${options.provider}`);
    }

    if (overrideProvider || options.model) {
      const nextProvider = overrideProvider ?? session.provider;
      const nextModel = options.model ?? config.providers[nextProvider].defaultModel;

      if (nextProvider !== session.provider || nextModel !== session.model) {
        await store.updateModel(session, nextProvider, nextModel);
      }
    }

    if (options.prompt) {
      const trustedConfig = await ensureWorkspaceTrust(session.workspaceRoot, config, ui);

      if (!trustedConfig) {
        process.exitCode = 1;
        return;
      }

      config = trustedConfig;
      await runOneShot(options.prompt, session, config, store, ui, runtimeProfile);
      return;
    }

    // The TUI binary is built in the tui/ subdirectory relative to the project root
    const tuiBin = join(projectRoot, "tui", "vetala");

    const tuiProcess = spawn(tuiBin, ["--workspace", session.workspaceRoot], {
      stdio: "inherit"
    });

    tuiProcess.on("close", (code) => {
      process.exit(code ?? 0);
    });
  });

await program.parseAsync(process.argv);

async function resolveSession(
  store: SessionStore,
  workspaceRoot: string,
  defaultProvider: ProviderName,
  defaultModel: string,
  options: { new?: boolean; resume?: string }
): Promise<SessionState> {
  if (options.resume) {
    return store.loadSession(options.resume);
  }

  return store.createSession(workspaceRoot, defaultProvider, defaultModel);
}

async function runOneShot(
  prompt: string,
  session: SessionState,
  config: Awaited<ReturnType<typeof loadConfig>>,
  store: SessionStore,
  ui: TerminalUI,
  runtimeProfile: ReturnType<typeof detectRuntimeHostProfile>
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
      runtimeProfile,
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

function resolveProviderOption(value: string | undefined): ProviderName | undefined {
  return resolveProviderName(value);
}
