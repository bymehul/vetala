import type { InkUiEntry } from "./ink-terminal-ui.js";

export interface TranscriptCard {
  id: string;
  entries: InkUiEntry[];
}

export function buildTranscriptCards(entries: InkUiEntry[]): TranscriptCard[] {
  const cards: TranscriptCard[] = [];
  let currentTurn: TranscriptCard | null = null;

  for (const entry of entries) {
    if (entry.kind === "user") {
      currentTurn = {
        id: entry.id,
        entries: [entry]
      };
      cards.push(currentTurn);
      continue;
    }

    if (!currentTurn) {
      cards.push({
        id: entry.id,
        entries: [entry]
      });
      continue;
    }

    currentTurn.entries.push(entry);
  }

  return cards;
}
