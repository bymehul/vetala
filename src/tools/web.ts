import type { ToolContext, ToolSpec } from "../types.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_CONTENT = 12_000;

export function createWebTools(): ToolSpec[] {
  return [fetchUrlTool, webSearchTool];
}

export function createWebToolsForConfig(includeSearchTool: boolean): ToolSpec[] {
  return includeSearchTool ? [fetchUrlTool, webSearchTool] : [fetchUrlTool];
}

const fetchUrlTool: ToolSpec = {
  name: "fetch_url",
  description: "Fetch a URL over HTTP or HTTPS after web access has been approved for the session.",
  jsonSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch."
      }
    },
    required: ["url"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const url = requiredString(args.url, "url");

    if (!await context.approvals.ensureWebAccess()) {
      return denied("Web access denied.");
    }

    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return denied(`Unsupported URL protocol: ${parsed.protocol}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "user-agent": "vetala/0.1"
        }
      });
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const rendered = renderFetchedBody(body, contentType);

      return {
        summary: `Fetched ${url} (${response.status})`,
        content: [`status: ${response.status}`, `content-type: ${contentType}`, "", rendered]
          .join("\n")
          .trim(),
        isError: !response.ok
      };
    } finally {
      clearTimeout(timeout);
    }
  }
};

const webSearchTool: ToolSpec = {
  name: "web_search",
  description: "Search the web through the configured search provider after web access is approved.",
  jsonSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query."
      },
      limit: {
        type: "integer",
        description: "Maximum number of results to return. Defaults to 5."
      }
    },
    required: ["query"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const query = requiredString(args.query, "query");
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : 5;

    if (!await context.approvals.ensureWebAccess()) {
      return denied("Web access denied.");
    }

    try {
      const results = await context.searchProvider.search(query, limit);
      return {
        summary: `Returned ${results.length} search results`,
        content: results
          .map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`)
          .join("\n\n"),
        isError: false
      };
    } catch (error) {
      return {
        summary: "Search provider error",
        content: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }
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

function denied(message: string) {
  return {
    summary: message,
    content: message,
    isError: true
  };
}

function renderFetchedBody(body: string, contentType: string): string {
  if (contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2).slice(0, MAX_FETCH_CONTENT);
    } catch {
      return body.slice(0, MAX_FETCH_CONTENT);
    }
  }

  if (contentType.includes("text/html")) {
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_FETCH_CONTENT);
  }

  return body.slice(0, MAX_FETCH_CONTENT);
}
