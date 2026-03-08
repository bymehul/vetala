import type { ToolSpec } from "../types.js";

const MAX_SLEEP_MS = 60_000;

export function createTimingTools(): ToolSpec[] {
  return [sleepTool];
}

const sleepTool: ToolSpec = {
  name: "sleep",
  description: "Pause briefly before the next tool call. Useful after starting a background process or waiting for generated files or logs.",
  jsonSchema: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "How long to wait in seconds. Maximum 60 seconds."
      }
    },
    required: ["seconds"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs) {
    const args = expectObject(rawArgs);
    const seconds = requiredNumber(args.seconds, "seconds");
    const sleepMs = clampSleepMs(seconds);

    await delay(sleepMs);

    return {
      summary: `Waited ${formatSleepSeconds(sleepMs / 1000)} seconds`,
      content: `Paused for ${formatSleepSeconds(sleepMs / 1000)} seconds.`,
      isError: false
    };
  }
};

function expectObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool arguments must be a JSON object.");
}

function requiredNumber(value: unknown, key: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`Missing numeric argument: ${key}`);
}

function clampSleepMs(seconds: number): number {
  if (seconds <= 0) {
    throw new Error("seconds must be greater than 0.");
  }

  return Math.min(MAX_SLEEP_MS, Math.round(seconds * 1000));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatSleepSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}
