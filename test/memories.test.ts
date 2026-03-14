import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { runMemoriesPipelineOnce } from "../src/memories/pipeline.js";
import { SessionStore } from "../src/session-store.js";
import { ensureAppPaths } from "../src/xdg.js";

test("Memories pipeline creates the data layout and placeholder files", async () => {
  await withIsolatedXdg(async () => {
    const config = await loadConfig();
    const store = new SessionStore();

    await runMemoriesPipelineOnce(config, store);

    const paths = await ensureAppPaths();
    const summary = await readFile(path.join(paths.memoriesDir, "memory_summary.md"), "utf8");
    const canonical = await readFile(path.join(paths.memoriesDir, "MEMORY.md"), "utf8");
    const raw = await readFile(path.join(paths.memoriesDir, "raw_memories.md"), "utf8");

    assert.match(summary, /No consolidated memories yet/);
    assert.match(canonical, /No consolidated memories yet/);
    assert.match(raw, /No raw memories yet/);
  });
});

test("Memories pipeline consolidates staged records without provider auth", async () => {
  await withIsolatedXdg(async () => {
    const config = await loadConfig();
    const store = new SessionStore();
    const paths = await ensureAppPaths();

    const now = new Date().toISOString();
    const state = {
      stage1: {
        "session-test-1": {
          sessionId: "session-test-1",
          workspaceRoot: "/tmp/workspace",
          updatedAt: now,
          createdAt: now,
          rawMemory: "Raw memory for test.",
          rolloutSummary: "User asked about bytecode.",
          rolloutSlug: "bytecode",
          usageCount: 0
        }
      },
      phase2: {
        lastSelection: [],
        lastRunAt: null
      }
    };

    await writeFile(path.join(paths.memoriesDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await runMemoriesPipelineOnce(config, store);

    const summary = await readFile(path.join(paths.memoriesDir, "memory_summary.md"), "utf8");
    assert.match(summary, /Memory summary \(fallback\)/);
    assert.match(summary, /User asked about bytecode/);

    const updatedRaw = JSON.parse(
      await readFile(path.join(paths.memoriesDir, "state.json"), "utf8")
    ) as {
      stage1: Record<string, { usageCount: number; lastUsedAt?: string }>;
    };

    const record = updatedRaw.stage1["session-test-1"];
    assert.ok(record);
    if (!record) {
      return;
    }
    assert.equal(record.usageCount, 1);
    assert.ok(record.lastUsedAt);
  });
});

test("Memories pipeline skips stale records based on lastUsedAt", async () => {
  await withIsolatedXdg(async () => {
    const baseConfig = await loadConfig();
    const config = {
      ...baseConfig,
      memories: {
        ...baseConfig.memories,
        maxUnusedDays: 1
      }
    };
    const store = new SessionStore();
    const paths = await ensureAppPaths();

    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const state = {
      stage1: {
        "session-test-2": {
          sessionId: "session-test-2",
          workspaceRoot: "/tmp/workspace",
          updatedAt: now.toISOString(),
          createdAt: now.toISOString(),
          rawMemory: "Stale memory.",
          rolloutSummary: "Old summary.",
          usageCount: 3,
          lastUsedAt: stale
        }
      },
      phase2: {
        lastSelection: [],
        lastRunAt: null
      }
    };

    await writeFile(path.join(paths.memoriesDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await runMemoriesPipelineOnce(config, store);

    const raw = await readFile(path.join(paths.memoriesDir, "raw_memories.md"), "utf8");
    assert.match(raw, /No raw memories yet/);
  });
});

async function withIsolatedXdg(run: () => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), "vetala-xdg-"));
  const originalConfig = process.env.XDG_CONFIG_HOME;
  const originalData = process.env.XDG_DATA_HOME;
  const envKeys = [
    "SARVAM_API_KEY",
    "SARVAM_SUBSCRIPTION_KEY",
    "SARVAM_TOKEN",
    "SARVAM_BASE_URL",
    "SARVAM_MODEL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_MODEL",
    "VETALA_PROVIDER",
    "TATTVA_PROVIDER"
  ];
  const originalEnv = new Map<string, string | undefined>();

  for (const key of envKeys) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  process.env.XDG_CONFIG_HOME = path.join(base, "config");
  process.env.XDG_DATA_HOME = path.join(base, "data");

  try {
    await run();
  } finally {
    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

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
