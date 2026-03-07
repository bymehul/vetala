import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { ReplApp } from "./ink/repl-app.js";
import { SessionStore } from "./session-store.js";
import { TerminalUI } from "./terminal-ui.js";
import type { SessionState } from "./types.js";

interface ReplDependencies {
  ui: TerminalUI;
  store: SessionStore;
}

export async function startRepl(initialSession: SessionState, dependencies: ReplDependencies): Promise<void> {
  void dependencies.ui;
  const config = await loadConfig();
  const app = render(
    <ReplApp
      initialConfig={config}
      initialSession={initialSession}
      store={dependencies.store}
    />,
    {
      exitOnCtrlC: false
    }
  );

  await app.waitUntilExit();
}
