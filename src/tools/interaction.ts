import type { ToolSpec } from "../types.js";

export function createInteractionTools(): ToolSpec[] {
  return [askUserTool];
}

const askUserTool: ToolSpec = {
  name: "ask_user",
  description: "Ask the user a question and wait for their response. Useful for getting missing context, architectural decisions, or asking the user to perform a manual action (like logging in).",
  jsonSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user."
      }
    },
    required: ["question"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const question = requiredString(args.question, "question");
    
    const answer = await context.interaction.askUser(question);
    
    return {
      summary: `Asked user: "${question}"`,
      content: answer.trim() ? `User replied:\n${answer}` : "(user provided no response)",
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

function requiredString(value: unknown, key: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing string argument: ${key}`);
}
