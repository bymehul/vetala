import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { TerminalUI } from "./terminal-ui.js";
import type { EffectiveConfig } from "./types.js";

export async function ensureWorkspaceTrust(
  workspaceRoot: string,
  config: EffectiveConfig,
  ui: TerminalUI
): Promise<EffectiveConfig | null> {
  if (!stdin.isTTY || !stdout.isTTY) {
    ui.error(
      `Workspace ${workspaceRoot} requires an interactive trust confirmation. Re-run vetala in a TTY to approve it.`
    );
    return null;
  }

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true
  });

  try {
    while (true) {
      ui.printTrustPrompt(workspaceRoot);
      const answer = (await rl.question(chalk.bold("\nSelect 1 or 2: "))).trim().toLowerCase();

      if (answer === "" || answer === "1" || answer === "yes" || answer === "y") {
        return config;
      }

      if (answer === "2" || answer === "no" || answer === "n" || answer === "exit") {
        ui.warn("Workspace not trusted. Exiting.");
        return null;
      }
    }
  } finally {
    rl.close();
  }
}
