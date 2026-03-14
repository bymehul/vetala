import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { SessionStore } from "../src/session-store.js";

test("Session summaries include a preview and skip slash commands", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const session = await store.createSession("/tmp/workspace", "sarvam-105b");

    await store.appendMessage(session, {
      role: "user",
      content: "/help",
      timestamp: "2026-03-14T00:00:00.000Z"
    });
    await store.appendMessage(session, {
      role: "user",
      content: "What is bytecode?",
      timestamp: "2026-03-14T00:00:01.000Z"
    });

    const summaries = await store.listSessionSummaries("/tmp/workspace");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.preview, "What is bytecode?");
    assert.equal(summaries[0]?.messageCount, 2);
  });
});

test("resolveResumeSelection supports latest, index, and id prefix", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const workspace = "/tmp/workspace";

    const session1 = await store.createSession(workspace, "sarvam-105b");
    await store.appendMessage(session1, {
      role: "user",
      content: "First session",
      timestamp: "2026-03-14T00:00:00.000Z"
    });

    await delay(10);

    const session2 = await store.createSession(workspace, "sarvam-105b");
    await store.appendMessage(session2, {
      role: "user",
      content: "Second session",
      timestamp: "2026-03-14T00:00:05.000Z"
    });

    const latest = await store.resolveResumeSelection(workspace, "latest");
    assert.equal(latest.status, "ok");
    if (latest.status === "ok") {
      assert.equal(latest.session.id, session2.id);
    }

    const byIndex = await store.resolveResumeSelection(workspace, "1");
    assert.equal(byIndex.status, "ok");
    if (byIndex.status === "ok") {
      assert.equal(byIndex.session.id, session1.id);
    }

    const prefix = session2.id.slice(0, 8);
    const byPrefix = await store.resolveResumeSelection(workspace, prefix);
    assert.equal(byPrefix.status, "ok");
    if (byPrefix.status === "ok") {
      assert.equal(byPrefix.session.id, session2.id);
    }
  });
});

test("Resume listing is scoped per workspace", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const session1 = await store.createSession("/tmp/workspace", "sarvam-105b");
    await store.appendMessage(session1, {
      role: "user",
      content: "From workspace one",
      timestamp: "2026-03-14T01:00:00.000Z"
    });

    const session2 = await store.createSession("/tmp/other", "sarvam-105b");
    await store.appendMessage(session2, {
      role: "user",
      content: "From workspace two",
      timestamp: "2026-03-14T01:01:00.000Z"
    });

    const summaries = await store.listSessionSummaries("/tmp/workspace");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.workspaceRoot, "/tmp/workspace");
  });
});

test("Empty sessions are excluded from resume summaries", async () => {
  await withIsolatedXdg(async () => {
    const store = new SessionStore();
    const workspace = "/tmp/workspace";

    await store.createSession(workspace, "sarvam-105b");

    const sessionWithMessage = await store.createSession(workspace, "sarvam-105b");
    await store.appendMessage(sessionWithMessage, {
      role: "user",
      content: "Keep this session",
      timestamp: "2026-03-14T02:00:00.000Z"
    });

    const summaries = await store.listSessionSummaries(workspace);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.id, sessionWithMessage.id);
  });
});

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
