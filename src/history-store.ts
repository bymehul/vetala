import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { ensureAppPaths } from "./xdg.js";
import type { EffectiveConfig } from "./types.js";

const HISTORY_SOFT_CAP_RATIO = 0.8;

export async function appendHistoryEntry(
  config: EffectiveConfig,
  sessionId: string,
  text: string
): Promise<void> {
  if (config.history.persistence === "none") {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const paths = await ensureAppPaths();
  const entry = {
    session_id: sessionId,
    ts: Math.floor(Date.now() / 1000),
    text: trimmed
  };
  const line = `${JSON.stringify(entry)}\n`;

  await appendFile(paths.historyFile, line, "utf8");
  await enforceHistoryLimit(paths.historyFile, config.history.maxBytes);
}

async function enforceHistoryLimit(historyFile: string, maxBytes: number | null): Promise<void> {
  if (!maxBytes || maxBytes <= 0) {
    return;
  }

  let currentSize = 0;
  try {
    const info = await stat(historyFile);
    currentSize = info.size;
  } catch {
    return;
  }

  if (currentSize <= maxBytes) {
    return;
  }

  let contents = "";
  try {
    contents = await readFile(historyFile, "utf8");
  } catch {
    return;
  }

  const lines = contents.split("\n").filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  const softCap = Math.max(1, Math.floor(maxBytes * HISTORY_SOFT_CAP_RATIO));
  const keepLines: string[] = [];
  let totalBytes = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = `${lines[index]}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (totalBytes + lineBytes > softCap && keepLines.length > 0) {
      break;
    }
    if (totalBytes + lineBytes > maxBytes && keepLines.length > 0) {
      break;
    }
    keepLines.push(line);
    totalBytes += lineBytes;
  }

  keepLines.reverse();
  if (keepLines.length === 0) {
    return;
  }

  await writeFile(historyFile, keepLines.join(""), "utf8");
}
