import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, readFile as readFsFile, writeFile } from "node:fs/promises";
import { undoLastEdit } from "../src/edit-history.js";
import { ApprovalManager } from "../src/approvals.js";
import { compactConversation } from "../src/context-memory.js";
import {
  clearSavedAuth,
  isWorkspaceTrusted,
  loadConfig,
  saveProviderDefaults,
  saveAuthFingerprint,
  saveChatDefaults,
  saveDefaultModel,
  savePersistentAuth,
  trustWorkspace,
  withSessionAuth
} from "../src/config.js";
import { buildSlashSuggestions } from "../src/ink/command-suggestions.js";
import { buildTranscriptCards } from "../src/ink/transcript-cards.js";
import { PathPolicy } from "../src/path-policy.js";
import {
  detectRuntimeHostProfile,
  formatRuntimeHostSummary,
  formatRuntimeTerminalSummary
} from "../src/runtime-profile.js";
import {
  extractDuckDuckGoResults,
  extractStackOverflowResults,
  normalizeSearchProviderName
} from "../src/search-provider.js";
import { SessionStore } from "../src/session-store.js";
import { SkillRuntime } from "../src/skills/runtime.js";
import type { SkillCatalogEntry } from "../src/skills/types.js";
import { createToolRegistry } from "../src/tools/index.js";
import type { PersistedMessage, SessionState, ToolCall, ToolContext } from "../src/types.js";

test("SessionStore persists and reloads JSONL sessions", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const session = await store.createSession("/tmp/workspace", "sarvam-105b");

    await store.appendMessage(session, {
      role: "user",
      content: "hello",
      timestamp: "2026-03-07T00:00:00.000Z"
    });

    const loaded = await store.loadSession(session.id);

    assert.equal(loaded.id, session.id);
    assert.equal(loaded.workspaceRoot, "/tmp/workspace");
    assert.equal(loaded.model, "sarvam-105b");
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.content, "hello");
  });
});

test("PathPolicy grants out-of-tree access for the approved root", async () => {
  await withIsolatedXdg(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vetala-workspace-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "vetala-outside-"));
    const outsideFile = path.join(outside, "notes.txt");
    await mkdir(root, { recursive: true });
    await writeFile(outsideFile, "hello", "utf8");

    const store = new SessionStore();
    const session = await store.createSession(root, "sarvam-105b");
    const approvals = new ApprovalManager(session, store, async () => "session");
    const policy = new PathPolicy(root, approvals);

    const resolved = await policy.ensureReadable(outsideFile);

    assert.equal(resolved, outsideFile);
    assert.ok(session.approvals.outOfTreeRoots.includes(outside));
  });
});

test("Config persists trusted workspaces", async () => {
  await withIsolatedXdg(async () => {
    let config = await loadConfig();

    assert.equal(isWorkspaceTrusted(config, "/tmp/project"), false);
    await trustWorkspace("/tmp/project");

    config = await loadConfig();
    assert.equal(isWorkspaceTrusted(config, "/tmp/project"), true);
    assert.deepEqual(config.trustedWorkspaces, ["/tmp/project"]);
  });
});

test("Config stores auth fingerprints and default model without persisting raw auth", async () => {
  await withIsolatedXdg(async () => {
    await saveDefaultModel("sarvam-105b");
    await saveAuthFingerprint("bearer", "secret-token");

    let config = await loadConfig();
    assert.equal(config.defaultModel, "sarvam-105b");
    assert.equal(config.authValue, undefined);
    assert.equal(config.authSource, "stored_hash");
    assert.equal(config.authMode, "bearer");
    assert.match(config.authFingerprint ?? "", /^[a-f0-9]{64}$/);

    config = withSessionAuth(config, "subscription_key", "sk_test");
    assert.equal(config.authValue, "sk_test");
    assert.equal(config.authSource, "session");

    await clearSavedAuth();
    config = await loadConfig();
    assert.equal(config.authSource, "missing");
    assert.equal(config.authFingerprint, undefined);
  });
});

test("Config persists reasoning effort defaults", async () => {
  await withIsolatedXdg(async () => {
    await saveChatDefaults("sarvam-105b-32k", "high");

    const config = await loadConfig();
    assert.equal(config.defaultModel, "sarvam-105b-32k");
    assert.equal(config.reasoningEffort, "high");
  });
});

test("Config migrates legacy tattva XDG paths into vetala paths", async () => {
  await withIsolatedXdg(async () => {
    const configHome = process.env.XDG_CONFIG_HOME ?? "";
    const dataHome = process.env.XDG_DATA_HOME ?? "";
    const legacyConfigDir = path.join(configHome, "tattva");
    const legacyDataDir = path.join(dataHome, "tattva");

    await mkdir(legacyConfigDir, { recursive: true });
    await mkdir(path.join(legacyDataDir, "sessions"), { recursive: true });
    await writeFile(
      path.join(legacyConfigDir, "config.json"),
      `${JSON.stringify({ defaultModel: "sarvam-105b-32k" }, null, 2)}\n`,
      "utf8"
    );

    const config = await loadConfig();
    assert.equal(config.defaultModel, "sarvam-105b-32k");
    assert.match(config.configPath, new RegExp(`[\\\\/]vetala[\\\\/]config\\.json$`));
    assert.match(config.dataPath, new RegExp(`[\\\\/]vetala$`));
  });
});

test("Config can persist a raw API key for future sessions", async () => {
  await withIsolatedXdg(async () => {
    await savePersistentAuth("subscription_key", "sk_live_demo");

    let config = await loadConfig();
    assert.equal(config.authMode, "subscription_key");
    assert.equal(config.authValue, "sk_live_demo");
    assert.equal(config.authSource, "stored");
    assert.match(config.authFingerprint ?? "", /^[a-f0-9]{64}$/);

    await clearSavedAuth();
    config = await loadConfig();
    assert.equal(config.authSource, "missing");
  });
});

test("SessionStore persists pinned skills across reload", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const session = await store.createSession("/tmp/workspace", "sarvam-105b");

    await store.pinSkill(session, "code-review");
    await store.pinSkill(session, "react-vite-guide");
    await store.unpinSkill(session, "code-review");

    const loaded = await store.loadSession(session.id);
    assert.deepEqual(loaded.pinnedSkills, ["react-vite-guide"]);
  });
});

test("SessionStore persists read files across reload", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const session = await store.createSession("/tmp/workspace", "sarvam-105b");

    await store.appendReadFile(session, "/tmp/workspace/src/app.ts");
    await store.appendReadFile(session, "/tmp/workspace/src/app.ts");

    const loaded = await store.loadSession(session.id);
    assert.deepEqual(loaded.readFiles, ["/tmp/workspace/src/app.ts"]);
    assert.deepEqual(loaded.referencedFiles, ["/tmp/workspace/src/app.ts"]);
  });
});

test("Config reads SARVAM_API_KEY as subscription key auth", async () => {
  await withIsolatedXdg(async () => {
    const originalApiKey = process.env.SARVAM_API_KEY;
    process.env.SARVAM_API_KEY = "sk_live_demo";

    try {
      const config = await loadConfig();
      assert.equal(config.authMode, "subscription_key");
      assert.equal(config.authValue, "sk_live_demo");
      assert.equal(config.authSource, "env");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.SARVAM_API_KEY;
      } else {
        process.env.SARVAM_API_KEY = originalApiKey;
      }
    }
  });
});

test("Config can switch the default provider to OpenRouter", async () => {
  await withIsolatedXdg(async () => {
    const originalProvider = process.env.VETALA_PROVIDER;
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const originalModel = process.env.OPENROUTER_MODEL;

    process.env.VETALA_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "or_demo_key";
    process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";

    try {
      const config = await loadConfig();
      assert.equal(config.defaultProvider, "openrouter");
      assert.equal(config.defaultModel, "openai/gpt-4o-mini");
      assert.equal(config.authMode, "bearer");
      assert.equal(config.authSource, "env");
      assert.equal(config.providers.openrouter.authSource, "env");
      assert.equal(config.providers.sarvam.defaultModel, "sarvam-105b");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.VETALA_PROVIDER;
      } else {
        process.env.VETALA_PROVIDER = originalProvider;
      }

      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }

      if (originalModel === undefined) {
        delete process.env.OPENROUTER_MODEL;
      } else {
        process.env.OPENROUTER_MODEL = originalModel;
      }
    }
  });
});

test("Config persists provider-specific model defaults", async () => {
  await withIsolatedXdg(async () => {
    await saveProviderDefaults("openrouter", "google/gemini-2.0-flash-001");

    const config = await loadConfig();
    assert.equal(config.defaultProvider, "openrouter");
    assert.equal(config.defaultModel, "google/gemini-2.0-flash-001");
    assert.equal(config.providers.sarvam.defaultModel, "sarvam-105b");
  });
});

test("Config defaults web search to DuckDuckGo", async () => {
  await withIsolatedXdg(async () => {
    const config = await loadConfig();
    assert.equal(config.searchProviderName, "duckduckgo");
  });
});

test("Runtime profile detection normalizes host and terminal metadata", () => {
  const profile = detectRuntimeHostProfile({
    env: {
      SHELL: "/usr/bin/bash",
      TERM: "xterm-256color",
      TERM_PROGRAM: "vscode",
      TERM_PROGRAM_VERSION: "1.99.0",
      COLORTERM: "truecolor"
    },
    platform: "linux",
    arch: "x64",
    release: "6.8.0",
    osVersion: "Linux 6.8.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    columns: 132,
    rows: 40
  });

  assert.equal(profile.shell, "bash");
  assert.equal(profile.terminalProgram, "vscode 1.99.0");
  assert.equal(profile.terminalType, "xterm-256color");
  assert.equal(profile.colorSupport, "truecolor");
  assert.equal(formatRuntimeHostSummary(profile), "Linux x64 (6.8.0)");
  assert.equal(
    formatRuntimeTerminalSummary(profile),
    "bash · vscode 1.99.0 / xterm-256color · 132x40"
  );
});

test("Conversation compaction keeps recent messages and summarizes older context", () => {
  const messages: PersistedMessage[] = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    timestamp: `2026-03-07T00:00:${String(index).padStart(2, "0")}.000Z`
  }));

  const compacted = compactConversation(messages, [
    "/tmp/app.ts",
    "/tmp/agent.ts"
  ]);

  assert.equal(compacted.compactedCount, 4);
  assert.equal(compacted.recentMessages.length, 12);
  assert.equal(compacted.recentMessages[0]?.content, "message 4");
  assert.match(compacted.memory ?? "", /4 earlier messages compacted/);
  assert.match(compacted.memory ?? "", /Referenced files: \/tmp\/app\.ts, \/tmp\/agent\.ts/);
});

test("Transcript cards group a user turn into a single card", () => {
  const cards = buildTranscriptCards([
    { id: "1", kind: "user", text: "hi" },
    { id: "2", kind: "activity", text: "Thinking with sarvam-105b." },
    { id: "3", kind: "assistant", text: "Vetala here." },
    { id: "4", kind: "user", text: "/help" },
    { id: "5", kind: "info", text: "/help\n/model" }
  ]);

  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.entries.length, 3);
  assert.equal(cards[1]?.entries.length, 2);
  assert.equal(cards[0]?.entries[2]?.kind, "assistant");
  assert.equal(cards[1]?.entries[1]?.kind, "info");
});

test("SkillRuntime indexes skills and reads nested files", async () => {
  await withIsolatedXdg(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vetala-skill-root-"));
    const skillRoot = path.join(tempRoot, "skill");
    const demoRoot = path.join(skillRoot, "demo-skill");
    const demoRefDir = path.join(demoRoot, "references");
    const originalSkillRoot = process.env.VETALA_SKILL_ROOT;

    await mkdir(demoRefDir, { recursive: true });
    await writeFile(
      path.join(demoRoot, "SKILL.md"),
      [
        "---",
        "name: demo-skill",
        "description:",
        "  Demo skill for runtime testing.",
        "---",
        "",
        "# Demo Skill",
        "",
        "## Overview",
        "",
        "See [reference](references/example.md)."
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(demoRefDir, "example.md"), "# Example\n\nReference body.", "utf8");

    process.env.VETALA_SKILL_ROOT = skillRoot;

    try {
      const store = new SessionStore();
      const session = await store.createSession("/tmp/workspace", "sarvam-105b");
      const runtime = new SkillRuntime({
        getSession: () => session,
        sessionStore: store
      });

      const skills = await runtime.listSkills();
      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.name, "demo-skill");
      assert.ok(skills[0]?.availableFiles.includes("references/example.md"));

      const loaded = await runtime.loadSkill("demo-skill");
      assert.match(loaded.overview, /Demo skill for runtime testing/);
      assert.match(loaded.overview, /references\/example\.md/);

      const file = await runtime.readSkillFile("demo-skill", "references/example.md");
      assert.match(file.content, /Reference body/);

      await runtime.pinSkill("demo-skill");
      assert.deepEqual(session.pinnedSkills, ["demo-skill"]);
    } finally {
      if (originalSkillRoot === undefined) {
        delete process.env.VETALA_SKILL_ROOT;
      } else {
        process.env.VETALA_SKILL_ROOT = originalSkillRoot;
      }
    }
  });
});

test("Slash suggestions match top-level commands and skill names", () => {
  const skills: SkillCatalogEntry[] = [
    {
      name: "git-workflow",
      description: "Git and PR workflow guidance.",
      rootPath: "/tmp/skill/git-workflow",
      entryPath: "/tmp/skill/git-workflow/SKILL.md",
      availableFiles: ["SKILL.md", "references/pull-request-workflow.md"]
    }
  ];

  const helpSuggestions = buildSlashSuggestions("/he", skills);
  assert.equal(helpSuggestions[0]?.completion, "/help");

  const undoSuggestions = buildSlashSuggestions("/un", skills);
  assert.equal(undoSuggestions[0]?.completion, "/undo");

  const skillSuggestions = buildSlashSuggestions("/skill use g", skills);
  assert.equal(skillSuggestions[0]?.completion, "/skill use git-workflow");

  const readSuggestions = buildSlashSuggestions("/skill read git-workflow re", skills);
  assert.equal(readSuggestions[0]?.completion, "/skill read git-workflow references/pull-request-workflow.md");
});

test("DuckDuckGo HTML parser extracts result titles and decoded URLs", () => {
  const html = [
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2Flearn">Rust &amp; Learn</a>',
    '<div class="result__snippet">Ownership and borrowing basics.</div>'
  ].join("\n");

  const results = extractDuckDuckGoResults(html, 5);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Rust & Learn");
  assert.equal(results[0]?.url, "https://rust-lang.org/learn");
  assert.equal(results[0]?.snippet, "Ownership and borrowing basics.");
});

test("Stack Overflow HTML parser extracts question links", () => {
  const html = [
    '<a href="/questions/12345/rust-ownership" class="s-link">Rust ownership</a>',
    '<div class="s-post-summary--content-excerpt">How does ownership work?</div>'
  ].join("\n");

  const results = extractStackOverflowResults(html, 5);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Rust ownership");
  assert.equal(results[0]?.url, "https://stackoverflow.com/questions/12345/rust-ownership");
  assert.equal(results[0]?.snippet, "How does ownership work?");
});

test("Search provider names normalize known values", () => {
  assert.equal(normalizeSearchProviderName("duckduckgo"), "duckduckgo");
  assert.equal(normalizeSearchProviderName("stack_overflow"), "stack_overflow");
  assert.equal(normalizeSearchProviderName("unknown"), undefined);
});

test("Tool registry hides web_search when the search provider is disabled", () => {
  const tools = createToolRegistry({ includeWebSearch: false })
    .list()
    .map((tool) => tool.name);

  assert.ok(tools.includes("search_repo"));
  assert.ok(tools.includes("read_file_chunk"));
  assert.ok(tools.includes("read_symbol"));
  assert.ok(tools.includes("apply_patch"));
  assert.ok(tools.includes("sleep"));
  assert.ok(tools.includes("fetch_url"));
  assert.ok(!tools.includes("web_search"));
  assert.ok(!tools.includes("stack_overflow_search"));
});

test("sleep tool pauses for a bounded duration", async () => {
  await withIsolatedXdg(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vetala-sleep-"));
    const store = new SessionStore();
    const session = await store.createSession(root, "sarvam-105b");
    const tools = createToolRegistry({ includeWebSearch: false });
    const context = createTestToolContext(root, session, store);

    const startedAt = Date.now();
    const result = await tools.execute(toolCall("sleep", { seconds: 0.05 }), context);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.isError, false);
    assert.match(result.summary, /Waited/);
    assert.ok(elapsedMs >= 40);
  });
});

test("Existing files must be read before write or patch", async () => {
  await withIsolatedXdg(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vetala-tools-"));
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf8");

    const store = new SessionStore();
    const session = await store.createSession(root, "sarvam-105b");
    const tools = createToolRegistry({ includeWebSearch: false });
    const context = createTestToolContext(root, session, store);

    const blockedWrite = await tools.execute(
      toolCall("write_file", { path: filePath, content: "rewritten\n" }),
      context
    );
    assert.equal(blockedWrite.isError, true);
    assert.match(blockedWrite.content, /before reading it/i);

    const blockedPatch = await tools.execute(
      toolCall("apply_patch", {
        path: filePath,
        changes: [{ search: "alpha", replace: "omega" }]
      }),
      context
    );
    assert.equal(blockedPatch.isError, true);
    assert.match(blockedPatch.content, /before reading it/i);

    const readResult = await tools.execute(
      toolCall("read_file", { path: filePath }),
      context
    );
    assert.equal(readResult.isError, false);
    assert.ok(session.readFiles.includes(filePath));

    const patched = await tools.execute(
      toolCall("apply_patch", {
        path: filePath,
        changes: [{ search: "alpha", replace: "omega" }]
      }),
      context
    );
    assert.equal(patched.isError, false);
    assert.match(await readFsFile(filePath, "utf8"), /omega/);

    const rewritten = await tools.execute(
      toolCall("write_file", { path: filePath, content: "rewritten\n" }),
      context
    );
    assert.equal(rewritten.isError, false);
    assert.equal(await readFsFile(filePath, "utf8"), "rewritten\n");
  });
});

test("search_repo supports regex mode and glob filters", async () => {
  await withIsolatedXdg(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vetala-search-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "src", "agent.ts"), "export class Agent {}\n", "utf8");
    await writeFile(path.join(root, "notes", "agent.txt"), "Agent in docs\n", "utf8");

    const store = new SessionStore();
    const session = await store.createSession(root, "sarvam-105b");
    const tools = createToolRegistry({ includeWebSearch: false });
    const context = createTestToolContext(root, session, store);

    const result = await tools.execute(
      toolCall("search_repo", {
        query: "\\bAgent\\b",
        mode: "regex",
        globs: ["**/*.ts"]
      }),
      context
    );

    assert.equal(result.isError, false);
    assert.match(result.content, /src\/agent\.ts:1:export class Agent/);
    assert.doesNotMatch(result.content, /notes\/agent\.txt/);
  });
});

test("undoLastEdit restores the previous file content", async () => {
  await withIsolatedXdg(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vetala-undo-"));
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf8");

    const store = new SessionStore();
    const session = await store.createSession(root, "sarvam-105b");
    const tools = createToolRegistry({ includeWebSearch: false });
    const context = createTestToolContext(root, session, store);

    await tools.execute(toolCall("read_file", { path: filePath }), context);
    await tools.execute(
      toolCall("apply_patch", {
        path: filePath,
        changes: [{ search: "alpha", replace: "omega" }]
      }),
      context
    );

    const undoResult = await undoLastEdit(session, store, async () => true);

    assert.equal(undoResult.isError, false);
    assert.equal(await readFsFile(filePath, "utf8"), "alpha\nbeta\n");
    assert.ok(session.edits[0]?.revertedAt);

    const loaded = await store.loadSession(session.id);
    assert.ok(loaded.edits[0]?.revertedAt);
  });
});

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `${name}-1`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function createTestToolContext(root: string, session: SessionState, store: SessionStore): ToolContext {
  return {
    cwd: root,
    workspaceRoot: root,
    approvals: {
      requestApproval: async () => true,
      hasSessionGrant: () => false,
      registerReference: async () => {},
      ensureWebAccess: async () => true
    },
    reads: {
      hasRead: (targetPath) => session.readFiles.includes(targetPath),
      registerRead: async (targetPath) => store.appendReadFile(session, targetPath)
    },
    edits: {
      recordEdit: async (edit) => store.appendEdit(session, edit)
    },
    paths: {
      resolve: (inputPath) => path.resolve(root, inputPath),
      ensureReadable: async (inputPath) => path.resolve(root, inputPath),
      ensureWritable: async (inputPath) => path.resolve(root, inputPath),
      allowedRoots: () => [root]
    },
    searchProvider: {
      name: "disabled",
      configured: false,
      search: async () => []
    }
  };
}

async function withIsolatedXdg(run: () => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), "vetala-xdg-"));
  const originalConfig = process.env.XDG_CONFIG_HOME;
  const originalData = process.env.XDG_DATA_HOME;

  process.env.XDG_CONFIG_HOME = path.join(base, "config");
  process.env.XDG_DATA_HOME = path.join(base, "data");

  try {
    await run();
  } finally {
    if (originalConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfig;
    }

    if (originalData === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalData;
    }
  }
}
