import type { ChatMessage, PersistedMessage } from "./types.js";

const RECENT_MESSAGE_COUNT = 12;
const MAX_MEMORY_EVENTS = 10;
const MAX_PREVIEW_LENGTH = 140;
const MAX_REFERENCED_FILES = 6;

export interface CompactedConversation {
  memory: string | null;
  compactedCount: number;
  recentMessages: ChatMessage[];
}

export function compactConversation(
  messages: PersistedMessage[],
  referencedFiles: string[]
): CompactedConversation {
  if (messages.length <= RECENT_MESSAGE_COUNT) {
    return {
      memory: null,
      compactedCount: 0,
      recentMessages: stripTimestamps(messages)
    };
  }

  const compactedMessages = messages.slice(0, -RECENT_MESSAGE_COUNT);

  return {
    memory: renderConversationMemory(compactedMessages, referencedFiles),
    compactedCount: compactedMessages.length,
    recentMessages: stripTimestamps(messages.slice(-RECENT_MESSAGE_COUNT))
  };
}

function renderConversationMemory(messages: PersistedMessage[], referencedFiles: string[]): string | null {
  const summarizedEvents = messages
    .map((message) => summarizeMessage(message))
    .filter((value): value is string => value !== null);

  if (summarizedEvents.length === 0) {
    return null;
  }

  const memoryLines = [
    `Conversation memory: ${messages.length} earlier messages compacted. Use this as prior context for follow-up requests.`,
    ...limitEvents(summarizedEvents).map((line) => `- ${line}`)
  ];

  if (referencedFiles.length > 0) {
    const renderedFiles = referencedFiles.slice(-MAX_REFERENCED_FILES).join(", ");
    const extraCount = Math.max(0, referencedFiles.length - MAX_REFERENCED_FILES);
    memoryLines.push(
      `Referenced files: ${renderedFiles}${extraCount > 0 ? `, and ${extraCount} more` : ""}`
    );
  }

  return memoryLines.join("\n");
}

function stripTimestamps(messages: PersistedMessage[]): ChatMessage[] {
  return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

function limitEvents(events: string[]): string[] {
  if (events.length <= MAX_MEMORY_EVENTS) {
    return events;
  }

  const headCount = 4;
  const tailCount = 4;
  const omittedCount = events.length - headCount - tailCount;

  return [
    ...events.slice(0, headCount),
    `${omittedCount} earlier events omitted.`,
    ...events.slice(-tailCount)
  ];
}

function summarizeMessage(message: PersistedMessage): string | null {
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const toolNames = [...new Set(message.tool_calls.map((toolCall) => toolCall.function.name).filter(Boolean))];
    const renderedTools = toolNames.length > 0 ? toolNames.join(", ") : "tools";
    const preview = summarizeContent(message.content);
    return preview
      ? `Vetala called ${renderedTools} and said: ${preview}`
      : `Vetala called ${renderedTools}.`;
  }

  const preview = summarizeContent(message.content);

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

function summarizeContent(content: string | null): string | null {
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

  return flattened.length > MAX_PREVIEW_LENGTH
    ? `${flattened.slice(0, MAX_PREVIEW_LENGTH - 3)}...`
    : flattened;
}
