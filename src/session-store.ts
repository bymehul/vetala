import crypto from "node:crypto";
import path from "node:path";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { ensureAppPaths } from "./xdg.js";
import type {
  ApprovalEvent,
  PersistedMessage,
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
  async createSession(workspaceRoot: string, model: string): Promise<SessionState> {
    const paths = await ensureAppPaths();
    const id = createSessionId();
    const createdAt = new Date().toISOString();
    const state: SessionState = {
      id,
      workspaceRoot,
      model,
      createdAt,
      updatedAt: createdAt,
      approvals: structuredClone(EMPTY_APPROVALS),
      messages: [],
      referencedFiles: [],
      readFiles: [],
      pinnedSkills: []
    };
    const record: SessionRecord = {
      type: "meta",
      id,
      workspaceRoot,
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
            model: record.model,
            createdAt: record.createdAt,
            updatedAt: record.createdAt,
            approvals: structuredClone(EMPTY_APPROVALS),
            messages: [],
            referencedFiles: [],
            readFiles: [],
            pinnedSkills: []
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
          state.model = record.model;
          state.updatedAt = record.timestamp;
          break;
        case "skill":
          ensureState(state, sessionId);
          applySkillRecord(state, record);
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

  async updateModel(session: SessionState, model: string): Promise<void> {
    const paths = await ensureAppPaths();
    const timestamp = new Date().toISOString();
    const record: SessionRecord = {
      type: "model",
      model,
      timestamp
    };

    session.model = model;
    session.updatedAt = timestamp;
    await appendFile(this.sessionPath(paths.sessionsDir, session.id), `${JSON.stringify(record)}\n`, "utf8");
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

function ensureState(state: SessionState | undefined, sessionId: string): asserts state is SessionState {
  if (!state) {
    throw new Error(`Session ${sessionId} is missing a meta record before other records.`);
  }
}

function exhaustive(_: never): never {
  throw new Error("Unexpected session record.");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
