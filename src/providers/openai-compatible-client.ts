import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ProviderRuntimeConfig,
  StreamChunk,
  StreamedAssistantTurn,
  ToolCall
} from "../types.js";
import type { ProviderDefinition } from "./catalog.js";

export interface StreamCallbacks {
  onText?: (chunk: string) => void;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
}

export interface ChatProviderClient {
  complete(request: ChatCompletionRequest, options?: ProviderRequestOptions): Promise<StreamedAssistantTurn>;
  stream(
    request: ChatCompletionRequest,
    callbacks?: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<StreamedAssistantTurn>;
}

export class OpenAICompatibleChatClient implements ChatProviderClient {
  constructor(
    private readonly definition: ProviderDefinition,
    private readonly config: ProviderRuntimeConfig
  ) {}

  async complete(
    request: ChatCompletionRequest,
    options: ProviderRequestOptions = {}
  ): Promise<StreamedAssistantTurn> {
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: this.headers(),
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        ...this.definition.buildBody(request),
        stream: false
      })
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices[0];

    if (!choice) {
      throw new Error(`${this.definition.label} returned no completion choices.`);
    }

    return {
      content: choice.message.content ?? "",
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason
    };
  }

  async stream(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks = {},
    options: ProviderRequestOptions = {}
  ): Promise<StreamedAssistantTurn> {
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: this.headers(),
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        ...this.definition.buildBody(request),
        stream: true
      })
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as ChatCompletionResponse;
      const choice = payload.choices[0];

      if (!choice) {
        throw new Error(`${this.definition.label} returned no completion choices.`);
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
      throw new Error(`${this.definition.label} streaming response did not include a body.`);
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
      consumeEvents(events.events, toolCalls, callbacks, {
        appendContent: (chunk) => {
          content += chunk;
        },
        setFinishReason: (reason) => {
          finishReason = reason;
        }
      });
    }

    buffer += decoder.decode();
    consumeEvents(splitEvents(`${buffer}\n\n`).events, toolCalls, callbacks, {
      appendContent: (chunk) => {
        content += chunk;
      },
      setFinishReason: (reason) => {
        finishReason = reason;
      }
    });

    return {
      content,
      toolCalls: [...toolCalls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, toolCall]) => toolCall),
      finishReason
    };
  }

  private endpoint(): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${this.definition.endpointPath}`;
  }

  private headers(): Record<string, string> {
    if (this.config.authMode === "missing" || !this.config.authValue) {
      throw new Error(
        `${this.definition.label} credentials are missing. Set ${this.definition.auth.envVars.join(", ")} before using Vetala.`
      );
    }

    return {
      "content-type": "application/json",
      ...this.definition.buildHeaders(this.config.authMode, this.config.authValue)
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

    return new Error(`${this.definition.errorLabel} error: ${message}`);
  }
}

function consumeEvents(
  events: string[],
  toolCalls: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: {
    appendContent(chunk: string): void;
    setFinishReason(reason: string): void;
  }
): void {
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");

    if (!data || data === "[DONE]") {
      continue;
    }

    const chunk = JSON.parse(data) as StreamChunk;

    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) {
        state.appendContent(choice.delta.content);
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
        state.setFinishReason(choice.finish_reason);
      }
    }
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
