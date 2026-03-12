import type { ToolSpec } from "../types.js";

export function createInteractionTools(): ToolSpec[] {
  return [askUserTool];
}

const askUserTool: ToolSpec = {
  name: "ask_user",
  description: "Ask the user one or more questions to gather preferences, clarify requirements, or make decisions. Asks them sequentially.",
  jsonSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The complete question to ask the user."
            },
            type: {
              type: "string",
              enum: ["text", "choice"],
              description: "Question type: 'text' for free-form input, 'choice' for multiple-choice."
            },
            options: {
              type: "array",
              items: { type: "string" },
              description: "The selectable choices. Required if type is 'choice'."
            }
          },
          required: ["question", "type"],
          additionalProperties: false
        },
        minItems: 1
      }
    },
    required: ["questions"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const questions = Array.isArray(args.questions) ? args.questions : [];

    if (questions.length === 0) {
      return {
        summary: "No questions provided",
        content: "You must provide at least one question.",
        isError: true
      };
    }

    const answers: string[] = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q || typeof q !== "object") continue;

      const questionText = typeof q.question === "string" ? q.question : "Question?";
      const qType = q.type === "choice" ? "choice" : "text";

      if (qType === "choice" && Array.isArray(q.options) && q.options.length > 0) {
        const stringOptions = q.options.map((o: unknown) => String(o));
        const index = await context.interaction.askSelect(questionText, stringOptions);
        answers.push(`Q: ${questionText}\nA: ${stringOptions[index]}`);
      } else {
        const textAnswer = await context.interaction.askText(questionText);
        answers.push(`Q: ${questionText}\nA: ${textAnswer}`);
      }
    }

    return {
      summary: `Asked user ${questions.length} question(s)`,
      content: answers.join("\n\n"),
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

