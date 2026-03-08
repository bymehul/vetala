import crypto from "node:crypto";
import path from "node:path";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { ensureAppPaths } from "./xdg.js";
import type {
  ApprovalEvent,
  FileEdit,
  PersistedMessage,
  ProviderName,
  SessionListItem,
  SessionRecord,
  SessionState
} from "./types.js";

const EMPTY_APPROVALS = {
  sessionActionKeys: [],
  outOfTreeRoots: [],
  webAccess: false
};

export class SessionStore {
  async createSession(workspaceRoot: string, providerOrModel: ProviderName | string, maybeModel?: string): Promise<SessionState> {
    const paths = await ensureAppPaths();
    const id = createSessionId();
    const createdAt = new Date().toISOString();
    const { provider, model } = normalizeProviderAndModel(providerOrModel, maybeModel);
    const state: SessionState = {
      id,
      workspaceRoot,
      provider,
      model,
      createdAt,
      updatedAt: createdAt,
      approvals: structuredClone(EMPTY_APPROVALS),
      messages: [],
      referencedFiles: [],
      readFiles: [],
      pinnedSkills: [],
      edits: []
    };
    const record: SessionRecord = {
      type: "meta",
      id,
      workspaceRoot,
      provider,
      model,
      createdAt
    };

    await appendFile(this.sessionPath(paths.sessionsDir, id), `${JSON.stringify(record)}\n`, "utf8");
    await this.updateLatestWorkspace(workspaceRoot, id);
    return state;
  }

  async loadSession(sessionId: string): Promise<SessionState> {
    const paths = await ensureAppPaths();
    const sessionPath = this.sessionPath(paths.sessionsDir, sessionId);
    const raw = await readFile(sessionPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    let state: SessionState | undefined;

    for (const line of lines) {
      const record = JSON.parse(line) as SessionRecord;

      switch (record.type) {
        case "meta":
          state = {
            id: record.id,
            workspaceRoot: record.workspaceRoot,
            provider: record.provider ?? "sarvam",
            model: record.model,
            createdAt: record.createdAt,
            updatedAt: record.createdAt,
            approvals: structuredClone(EMPTY_APPROVALS),
            messages: [],
            referencedFiles: [],
            readFiles: [],
            pinnedSkills: [],
            edits: []
          };
          break;
        case "message":
          ensureState(state, sessionId);
          state.messages.push(record.message);
          state.updatedAt = record.timestamp;
          break;
        case "approval":
          ensureState(state, sessionId);
          applyApproval(state, record.approval);
          state.updatedAt = record.approval.timestamp;
          break;
        case "reference":
          ensureState(state, sessionId);
          if (!state.referencedFiles.includes(record.path)) {
            state.referencedFiles.push(record.path);
          }
          state.updatedAt = record.timestamp;
          break;
        case "read":
          ensureState(state, sessionId);
          if (!state.readFiles.includes(record.path)) {
            state.readFiles.push(record.path);
          }
          if (!state.referencedFiles.includes(record.path)) {
            state.referencedFiles.push(record.path);
          }
          state.updatedAt = record.timestamp;
          break;
        case "model":
          ensureState(state, sessionId);
          if (record.provider) {
            state.provider = record.provider;
          }
          state.model = record.model;
          state.updatedAt = record.timestamp;
          break;
        case "skill":
          ensureState(state, sessionId);
          applySkillRecord(state, record);
          state.updatedAt = record.timestamp;
          break;
        case "edit":
          ensureState(state, sessionId);
          state.edits.push(record.edit);
          state.updatedAt = record.edit.timestamp;
          break;
        case "edit_revert":
          ensureState(state, sessionId);
          markEditReverted(state, record.editId, record.timestamp);
          state.updatedAt = record.timestamp;
          break;
        default:
          exhaustive(record);
      }
    }

    if (!state) {
      throw new Error(`Session ${sessionId} is missing a meta record.`);
    }

    return state;
  }

  async loadLatestForWorkspace(workspaceRoot: string): Promise<SessionState | null> {
    const latest = await this.readLatestWorkspaceMap();
    const sessionId = latest[workspaceRoot];

    if (!sessionId) {
      return null;
    }

    try {
      return await this.loadSession(sessionId);
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }

      throw error;
    }
  }

  async listSessions(): Promise<SessionListItem[]> {
    const paths = await ensureAppPaths();
    const entries = await readdir(paths.sessionsDir, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.replace(/\.jsonl$/, ""));

    const sessions = await Promise.all(ids.map((id) => this.loadSession(id)));
    return sessions
      .map((session) => ({
        id: session.id,
        workspaceRoot: session.workspaceRoot,
        provider: session.provider,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async appendMessage(session: SessionState, message: PersistedMessage): Promise<void> {
    const paths = await ensureAppPaths();
    const record: SessionRecord = {
      type: "message",
      timestamp: message.timestamp,
      message
    };

    session.messages.push(message);
    session.updatedAt = message.timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
    await this.updateLatestWorkspace(session.workspaceRoot, session.id);
  }

  async appendApproval(session: SessionState, approval: ApprovalEvent): Promise<void> {
    const paths = await ensureAppPaths();
    const record: SessionRecord = {
      type: "approval",
      approval
    };

    applyApproval(session, approval);
    session.updatedAt = approval.timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
  }

  async appendReference(session: SessionState, targetPath: string): Promise<void> {
    if (session.referencedFiles.includes(targetPath)) {
      return;
    }

    const paths = await ensureAppPaths();
    const timestamp = new Date().toISOString();
    const record: SessionRecord = {
      type: "reference",
      path: targetPath,
      timestamp
    };

    session.referencedFiles.push(targetPath);
    session.updatedAt = timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
  }

  async appendReadFile(session: SessionState, targetPath: string): Promise<void> {
    if (session.readFiles.includes(targetPath)) {
      return;
    }

    const paths = await ensureAppPaths();
    const timestamp = new Date().toISOString();
    const record: SessionRecord = {
      type: "read",
      path: targetPath,
      timestamp
    };

    session.readFiles.push(targetPath);
    if (!session.referencedFiles.includes(targetPath)) {
      session.referencedFiles.push(targetPath);
    }
    session.updatedAt = timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
    await this.updateLatestWorkspace(session.workspaceRoot, session.id);
  }

  async updateModel(session: SessionState, providerOrModel: ProviderName | string, maybeModel?: string): Promise<void> {
    const paths = await ensureAppPaths();
    const timestamp = new Date().toISOString();
    const { provider, model } = normalizeProviderAndModel(providerOrModel, maybeModel, session.provider);
    const record: SessionRecord = {
      type: "model",
      provider,
      model,
      timestamp
    };

    session.provider = provider;
    session.model = model;
    session.updatedAt = timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
  }

  async appendEdit(
    session: SessionState,
    input: Omit<FileEdit, "id" | "timestamp" | "revertedAt">
  ): Promise<FileEdit> {
    const paths = await ensureAppPaths();
    const edit: FileEdit = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString()
    };
    const record: SessionRecord = {
      type: "edit",
      edit
    };

    session.edits.push(edit);
    session.updatedAt = edit.timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
    await this.updateLatestWorkspace(session.workspaceRoot, session.id);
    return edit;
  }

  async markEditReverted(session: SessionState, editId: string): Promise<void> {
    const paths = await ensureAppPaths();
    const timestamp = new Date().toISOString();
    const record: SessionRecord = {
      type: "edit_revert",
      editId,
      timestamp
    };

    markEditReverted(session, editId, timestamp);
    session.updatedAt = timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
    await this.updateLatestWorkspace(session.workspaceRoot, session.id);
  }

  async pinSkill(session: SessionState, skillName: string): Promise<void> {
    if (session.pinnedSkills.includes(skillName)) {
      return;
    }

    await this.appendSkillRecord(session, {
      type: "skill",
      action: "pin",
      skillName,
      timestamp: new Date().toISOString()
    });
  }

  async unpinSkill(session: SessionState, skillName: string): Promise<void> {
    if (!session.pinnedSkills.includes(skillName)) {
      return;
    }

    await this.appendSkillRecord(session, {
      type: "skill",
      action: "unpin",
      skillName,
      timestamp: new Date().toISOString()
    });
  }

  async clearPinnedSkills(session: SessionState): Promise<void> {
    if (session.pinnedSkills.length === 0) {
      return;
    }

    await this.appendSkillRecord(session, {
      type: "skill",
      action: "clear",
      timestamp: new Date().toISOString()
    });
  }

  private async readLatestWorkspaceMap(): Promise<Record<string, string>> {
    const paths = await ensureAppPaths();

    try {
      const raw = await readFile(paths.latestWorkspaceFile, "utf8");
      return JSON.parse(raw) as Record<string, string>;
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }

      throw error;
    }
  }

  private async updateLatestWorkspace(workspaceRoot: string, sessionId: string): Promise<void> {
    const paths = await ensureAppPaths();
    const latest = await this.readLatestWorkspaceMap();

    latest[workspaceRoot] = sessionId;
    await writeFile(paths.latestWorkspaceFile, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  }

  private async appendSkillRecord(session: SessionState, record: Extract<SessionRecord, { type: "skill" }>): Promise<void> {
    const paths = await ensureAppPaths();
    applySkillRecord(session, record);
    session.updatedAt = record.timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
    await this.updateLatestWorkspace(session.workspaceRoot, session.id);
  }

  private sessionPath(sessionsDir: string, sessionId: string): string {
    return path.join(sessionsDir, `${sessionId}.jsonl`);
  }
}

function applyApproval(state: SessionState, approval: ApprovalEvent): void {
  if (approval.kind === "web_access") {
    state.approvals.webAccess = true;
    return;
  }

  if (approval.kind === "path_access") {
    if (!state.approvals.outOfTreeRoots.includes(approval.key)) {
      state.approvals.outOfTreeRoots.push(approval.key);
    }
    return;
  }

  if (!state.approvals.sessionActionKeys.includes(approval.key)) {
    state.approvals.sessionActionKeys.push(approval.key);
  }
}

function applySkillRecord(state: SessionState, record: Extract<SessionRecord, { type: "skill" }>): void {
  switch (record.action) {
    case "pin":
      if (record.skillName && !state.pinnedSkills.includes(record.skillName)) {
        state.pinnedSkills.push(record.skillName);
      }
      break;
    case "unpin":
      if (record.skillName) {
        state.pinnedSkills = state.pinnedSkills.filter((name) => name !== record.skillName);
      }
      break;
    case "clear":
      state.pinnedSkills = [];
      break;
    default:
      exhaustive(record.action);
  }
}

function createSessionId(): string {
  return crypto.randomUUID();
}

function normalizeProviderAndModel(
  providerOrModel: ProviderName | string,
  maybeModel?: string,
  fallbackProvider: ProviderName = "sarvam"
): { provider: ProviderName; model: string } {
  if (maybeModel !== undefined) {
    return {
      provider: providerOrModel as ProviderName,
      model: maybeModel
    };
  }

  return {
    provider: fallbackProvider,
    model: providerOrModel
  };
}

function ensureState(state: SessionState | undefined, sessionId: string): asserts state is SessionState {
  if (!state) {
    throw new Error(`Session ${sessionId} is missing a meta record before other records.`);
  }
}

function exhaustive(_: never): never {
  throw new Error("Unexpected session record.");
}

function markEditReverted(state: SessionState, editId: string, timestamp: string): void {
  const edit = state.edits.find((candidate) => candidate.id === editId);

  if (edit) {
    edit.revertedAt = timestamp;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
