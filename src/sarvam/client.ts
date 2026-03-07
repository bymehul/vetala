import type {
  ChatMessage,
  EffectiveConfig,
  SarvamChatCompletionRequest,
  SarvamChatCompletionResponse,
  SarvamStreamChunk,
  StreamedAssistantTurn,
  ToolCall
} from "../types.js";

interface StreamCallbacks {
  onText?: (chunk: string) => void;
}

export class SarvamClient {
  constructor(private readonly config: EffectiveConfig) {}

  async complete(request: SarvamChatCompletionRequest): Promise<StreamedAssistantTurn> {
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        ...request,
        messages: request.messages,
        stream: false
      })
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    const payload = (await response.json()) as SarvamChatCompletionResponse;
    const choice = payload.choices[0];

    if (!choice) {
      throw new Error("Sarvam returned no completion choices.");
    }

    return {
      content: choice.message.content ?? "",
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason
    };
  }

  async stream(request: SarvamChatCompletionRequest, callbacks: StreamCallbacks = {}): Promise<StreamedAssistantTurn> {
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        ...request,
        messages: request.messages,
        stream: true
      })
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as SarvamChatCompletionResponse;
      const choice = payload.choices[0];

      if (!choice) {
        throw new Error("Sarvam returned no completion choices.");
      }

      if (choice.message.content) {
        callbacks.onText?.(choice.message.content);
      }

      return {
        content: choice.message.content ?? "",
        toolCalls: choice.message.tool_calls ?? [],
        finishReason: choice.finish_reason
      };
    }

    if (!response.body) {
      throw new Error("Sarvam streaming response did not include a body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCall>();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = splitEvents(buffer);
      buffer = events.remaining;

      for (const event of events.events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (!data || data === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(data) as SarvamStreamChunk;

        for (const choice of chunk.choices ?? []) {
          if (choice.delta?.content) {
            content += choice.delta.content;
            callbacks.onText?.(choice.delta.content);
          }

          for (const deltaToolCall of choice.delta?.tool_calls ?? []) {
            const current = toolCalls.get(deltaToolCall.index) ?? {
              id: "",
              type: "function" as const,
              function: {
                name: "",
                arguments: ""
              }
            };

            if (deltaToolCall.id) {
              current.id = deltaToolCall.id;
            }

            if (deltaToolCall.type) {
              current.type = deltaToolCall.type;
            }

            if (deltaToolCall.function?.name) {
              current.function.name += deltaToolCall.function.name;
            }

            if (deltaToolCall.function?.arguments) {
              current.function.arguments += deltaToolCall.function.arguments;
            }

            toolCalls.set(deltaToolCall.index, current);
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      }
    }

    buffer += decoder.decode();

    for (const event of splitEvents(`${buffer}\n\n`).events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!data || data === "[DONE]") {
        continue;
      }

      const chunk = JSON.parse(data) as SarvamStreamChunk;

      for (const choice of chunk.choices ?? []) {
        if (choice.delta?.content) {
          content += choice.delta.content;
          callbacks.onText?.(choice.delta.content);
        }

        for (const deltaToolCall of choice.delta?.tool_calls ?? []) {
          const current = toolCalls.get(deltaToolCall.index) ?? {
            id: "",
            type: "function" as const,
            function: {
              name: "",
              arguments: ""
            }
          };

          if (deltaToolCall.id) {
            current.id = deltaToolCall.id;
          }

          if (deltaToolCall.type) {
            current.type = deltaToolCall.type;
          }

          if (deltaToolCall.function?.name) {
            current.function.name += deltaToolCall.function.name;
          }

          if (deltaToolCall.function?.arguments) {
            current.function.arguments += deltaToolCall.function.arguments;
          }

          toolCalls.set(deltaToolCall.index, current);
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }

    return {
      content,
      toolCalls: [...toolCalls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, toolCall]) => toolCall),
      finishReason
    };
  }

  private endpoint(): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  }

  private headers(): Record<string, string> {
    if (this.config.authMode === "missing" || !this.config.authValue) {
      throw new Error(
        "Sarvam credentials are missing. Set SARVAM_API_KEY, SARVAM_SUBSCRIPTION_KEY, or SARVAM_TOKEN before using vetala."
      );
    }

    return {
      "content-type": "application/json",
      ...(this.config.authMode === "bearer"
        ? { Authorization: `Bearer ${this.config.authValue}` }
        : { "api-subscription-key": this.config.authValue })
    };
  }

  private async toError(response: Response): Promise<Error> {
    let message = `${response.status} ${response.statusText}`;

    try {
      const payload = (await response.json()) as {
        error?: {
          message?: string;
        };
      };

      if (payload.error?.message) {
        message = payload.error.message;
      }
    } catch {
      // Keep the default response message.
    }

    return new Error(`Sarvam API error: ${message}`);
  }
}

function splitEvents(buffer: string): { events: string[]; remaining: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remaining = parts.pop() ?? "";
  return { events: parts, remaining };
}

export function withSystemMessage(systemContent: string, messages: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: systemContent }, ...messages];
}
