import type { ChatMessage, MemorySettings, PersistedMessage } from "./types.js";

const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  recentMessageCount: 12,
  maxMemoryEvents: 10,
  maxPreviewLength: 140,
  maxReferencedFiles: 6
};

export interface CompactedConversation {
  memory: string | null;
  compactedCount: number;
  recentMessages: ChatMessage[];
}

export function compactConversation(
  messages: PersistedMessage[],
  referencedFiles: string[],
  settings: MemorySettings = DEFAULT_MEMORY_SETTINGS
): CompactedConversation {
  if (messages.length <= settings.recentMessageCount) {
    return {
      memory: null,
      compactedCount: 0,
      recentMessages: stripTimestamps(messages)
    };
  }

  const compactedMessages = messages.slice(0, -settings.recentMessageCount);

  return {
    memory: renderConversationMemory(compactedMessages, referencedFiles, settings),
    compactedCount: compactedMessages.length,
    recentMessages: stripTimestamps(messages.slice(-settings.recentMessageCount))
  };
}

function renderConversationMemory(
  messages: PersistedMessage[],
  referencedFiles: string[],
  settings: MemorySettings
): string | null {
  const summarizedEvents = messages
    .map((message) => summarizeMessage(message, settings))
    .filter((value): value is string => value !== null);

  if (summarizedEvents.length === 0) {
    return null;
  }

  const memoryLines = [
    `Conversation memory: ${messages.length} earlier messages compacted. Use this as prior context for follow-up requests.`,
    ...limitEvents(summarizedEvents, settings.maxMemoryEvents).map((line) => `- ${line}`)
  ];

  if (referencedFiles.length > 0 && settings.maxReferencedFiles > 0) {
    const renderedFiles = referencedFiles.slice(-settings.maxReferencedFiles).join(", ");
    const extraCount = Math.max(0, referencedFiles.length - settings.maxReferencedFiles);
    memoryLines.push(
      `Referenced files: ${renderedFiles}${extraCount > 0 ? `, and ${extraCount} more` : ""}`
    );
  }

  return memoryLines.join("\n");
}

function stripTimestamps(messages: PersistedMessage[]): ChatMessage[] {
  return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

function limitEvents(events: string[], maxEvents: number): string[] {
  if (maxEvents <= 0) {
    return [];
  }
  if (events.length <= maxEvents) {
    return events;
  }

  if (maxEvents < 3) {
    return events.slice(-maxEvents);
  }

  const headCount = Math.min(4, Math.max(1, Math.floor((maxEvents - 1) / 2)));
  const tailCount = Math.min(4, Math.max(1, maxEvents - headCount - 1));
  const omittedCount = Math.max(0, events.length - headCount - tailCount);

  return [
    ...events.slice(0, headCount),
    `${omittedCount} earlier events omitted.`,
    ...events.slice(-tailCount)
  ];
}

function summarizeMessage(message: PersistedMessage, settings: MemorySettings): string | null {
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const toolNames = [...new Set(message.tool_calls.map((toolCall) => toolCall.function.name).filter(Boolean))];
    const renderedTools = toolNames.length > 0 ? toolNames.join(", ") : "tools";
    const preview = summarizeContent(message.content, settings.maxPreviewLength);
    return preview
      ? `Vetala called ${renderedTools} and said: ${preview}`
      : `Vetala called ${renderedTools}.`;
  }

  const preview = summarizeContent(message.content, settings.maxPreviewLength);

  if (!preview) {
    return null;
  }

  switch (message.role) {
    case "user":
      return `User asked: ${preview}`;
    case "assistant":
      return `Vetala replied: ${preview}`;
    case "tool":
      return `Tool result: ${preview}`;
    case "system":
      return `System note: ${preview}`;
  }
}

function summarizeContent(content: string | null, maxPreviewLength: number): string | null {
  if (!content) {
    return null;
  }

  const flattened = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!flattened) {
    return null;
  }

  return flattened.length > maxPreviewLength
    ? `${flattened.slice(0, Math.max(0, maxPreviewLength - 3))}...`
    : flattened;
}
