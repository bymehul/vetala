import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDiffPreview } from "./edits/diff.js";
import { SessionStore } from "./session-store.js";
import type { ApprovalRequest, FileEdit, SessionState, ToolContext, ToolResult } from "./types.js";

export function latestUndoableEdit(session: SessionState): FileEdit | null {
  for (let index = session.edits.length - 1; index >= 0; index -= 1) {
    const candidate = session.edits[index];

    if (candidate && !candidate.revertedAt) {
      return candidate;
    }
  }

  return null;
}

export async function undoLastEdit(
  session: SessionState,
  store: SessionStore,
  requestApproval: (request: ApprovalRequest) => Promise<boolean>,
  context?: ToolContext
): Promise<ToolResult> {
  const edit = latestUndoableEdit(session);

  if (!edit) {
    return denied("No undoable edits are recorded in this session.");
  }

  const currentContent = await readCurrentContent(edit.path);

  if (currentContent !== edit.afterContent) {
    return denied(
      `Cannot undo ${edit.path} because the file no longer matches the last recorded edit. Read or inspect the file before changing it again.`
    );
  }

  const approved = await requestApproval({
    kind: "write_file",
    key: `undo_edit:${edit.id}`,
    label: [
      "Allow undoing the last tracked edit?",
      `path: ${edit.path}`,
      `summary: ${edit.summary}`,
      "",
      await buildDiffPreview(edit.path, currentContent, edit.beforeContent, 2, context)
    ].join("\n")
  });

  if (!approved) {
    return denied(`Undo denied for ${edit.path}`);
  }

  if (edit.beforeContent === null) {
    await rm(edit.path, { force: true });
  } else {
    await mkdir(path.dirname(edit.path), { recursive: true });
    await writeFile(edit.path, edit.beforeContent, "utf8");
  }

  await store.markEditReverted(session, edit.id);

  return {
    summary: `Reverted ${edit.path}`,
    content: [
      `Reverted the last tracked edit in ${edit.path}.`,
      "",
      await buildDiffPreview(edit.path, currentContent, edit.beforeContent, 2, context)
    ].join("\n"),
    isError: false,
    referencedFiles: [edit.path]
  };
}

async function readCurrentContent(target: string): Promise<string | null> {
  try {
    const targetStats = await stat(target);

    if (!targetStats.isFile()) {
      return null;
    }

    return await readFile(target, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function denied(message: string): ToolResult {
  return {
    summary: message,
    content: message,
    isError: true
  };
}
