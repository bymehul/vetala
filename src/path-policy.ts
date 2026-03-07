import path from "node:path";
import { stat } from "node:fs/promises";
import { ApprovalManager } from "./approvals.js";

export class PathPolicy {
  constructor(
    private readonly workspaceRoot: string,
    private readonly approvals: ApprovalManager
  ) {}

  resolve(inputPath: string): string {
    return path.resolve(process.cwd(), inputPath);
  }

  allowedRoots(): string[] {
    return [this.workspaceRoot, ...this.approvals.allowedOutOfTreeRoots()];
  }

  async ensureReadable(inputPath: string): Promise<string> {
    const targetPath = this.resolve(inputPath);
    await this.ensureAllowed(targetPath);
    return targetPath;
  }

  async ensureWritable(inputPath: string): Promise<string> {
    const targetPath = this.resolve(inputPath);
    await this.ensureAllowed(targetPath, true);
    return targetPath;
  }

  private async ensureAllowed(targetPath: string, isWrite = false): Promise<void> {
    if (isWithin(targetPath, this.workspaceRoot)) {
      return;
    }

    for (const root of this.approvals.allowedOutOfTreeRoots()) {
      if (isWithin(targetPath, root)) {
        return;
      }
    }

    const requestedRoot = await pickApprovalRoot(targetPath, isWrite);
    const approved = await this.approvals.requestApproval({
      kind: "path_access",
      key: requestedRoot,
      label: [
        "Allow access outside the workspace root?",
        `workspace: ${this.workspaceRoot}`,
        `requested: ${targetPath}`,
        `grant root: ${requestedRoot}`
      ].join("\n")
    });

    if (!approved) {
      throw new Error(`Access denied for path outside workspace root: ${targetPath}`);
    }
  }
}

function isWithin(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pickApprovalRoot(targetPath: string, isWrite: boolean): Promise<string> {
  if (isWrite) {
    return path.dirname(targetPath);
  }

  try {
    const targetStats = await stat(targetPath);
    return targetStats.isDirectory() ? targetPath : path.dirname(targetPath);
  } catch {
    return path.dirname(targetPath);
  }
}
