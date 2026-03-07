import type { ApprovalEvent, ApprovalRequest, ApprovalScope, SessionState } from "./types.js";
import { SessionStore } from "./session-store.js";

export type PromptFn = (question: string) => Promise<string>;
export type ApprovalDecisionFn = (request: ApprovalRequest) => Promise<ApprovalScope>;

export class ApprovalManager {
  constructor(
    private readonly session: SessionState,
    private readonly sessionStore: SessionStore,
    private readonly prompt: PromptFn | null,
    private readonly decide: ApprovalDecisionFn | null = null
  ) {}

  hasSessionGrant(key: string): boolean {
    return (
      this.session.approvals.sessionActionKeys.includes(key) ||
      this.session.approvals.outOfTreeRoots.includes(key)
    );
  }

  allowedOutOfTreeRoots(): string[] {
    return [...this.session.approvals.outOfTreeRoots];
  }

  webAccessGranted(): boolean {
    return this.session.approvals.webAccess;
  }

  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (request.kind === "web_access" && this.session.approvals.webAccess) {
      return true;
    }

    if (request.kind === "path_access" && this.session.approvals.outOfTreeRoots.includes(request.key)) {
      return true;
    }

    if (
      request.kind !== "web_access" &&
      request.kind !== "path_access" &&
      this.session.approvals.sessionActionKeys.includes(request.key)
    ) {
      return true;
    }

    if (this.decide) {
      const decision = await this.decide(request);

      if (decision === "once") {
        return true;
      }

      if (decision === "session") {
        await this.persistApproval(request);
        return true;
      }

      return false;
    }

    if (!this.prompt) {
      return false;
    }

    const answer = (await this.prompt(`${request.label}\nAllow [o]nce, [s]ession, or [d]eny? `))
      .trim()
      .toLowerCase();

    if (answer === "o" || answer === "once") {
      return true;
    }

    if (answer === "s" || answer === "session") {
      await this.persistApproval(request);
      return true;
    }

    return false;
  }

  async ensureWebAccess(): Promise<boolean> {
    return this.requestApproval({
      kind: "web_access",
      key: "web_access",
      label: "Allow outbound web access for this session?"
    });
  }

  async registerReference(targetPath: string): Promise<void> {
    await this.sessionStore.appendReference(this.session, targetPath);
  }

  private async persistApproval(request: ApprovalRequest): Promise<void> {
    const approval: ApprovalEvent = {
      kind: request.kind,
      scope: "session",
      key: request.key,
      label: request.label,
      timestamp: new Date().toISOString()
    };

    await this.sessionStore.appendApproval(this.session, approval);
  }
}
