import type { SearchProvider, SearchProviderName, SearchResult } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_USER_AGENT = "vetala/0.1";

export const SEARCH_PROVIDER_NAMES: SearchProviderName[] = [
  "disabled",
  "duckduckgo",
  "stack_overflow",
  "brave",
  "bing"
];

export class DisabledSearchProvider implements SearchProvider {
  readonly name = "disabled";
  readonly configured = false;

  async search(_query: string, _limit: number): Promise<SearchResult[]> {
    throw new Error("web_search is disabled. Configure a search provider in the Vetala config to enable it.");
  }
}

abstract class HtmlSearchProvider implements SearchProvider {
  readonly configured = true;

  constructor(public readonly name: SearchProviderName) {}

  protected abstract buildUrl(query: string): string;
  protected abstract parseResults(html: string, limit: number): SearchResult[];

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.buildUrl(query), {
        method: "GET",
        signal: controller.signal,
        headers: {
          "user-agent": SEARCH_USER_AGENT,
          "accept-language": "en-US,en;q=0.8"
        }
      });

      if (!response.ok) {
        throw new Error(`${this.name} search failed: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const results = this.parseResults(html, limit);

      if (results.length === 0) {
        throw new Error(`${this.name} search returned no parsable results.`);
      }

      return results.slice(0, limit);
    } finally {
      clearTimeout(timeout);
    }
  }
}

class DuckDuckGoSearchProvider extends HtmlSearchProvider {
  constructor() {
    super("duckduckgo");
  }

  protected buildUrl(query: string): string {
    return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  }

  protected parseResults(html: string, limit: number): SearchResult[] {
    return extractDuckDuckGoResults(html, limit);
  }
}

class StackOverflowSearchProvider extends HtmlSearchProvider {
  constructor() {
    super("stack_overflow");
  }

  protected buildUrl(query: string): string {
    return `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`;
  }

  protected parseResults(html: string, limit: number): SearchResult[] {
    return extractStackOverflowResults(html, limit);
  }
}

class BraveSearchProvider extends HtmlSearchProvider {
  constructor() {
    super("brave");
  }

  protected buildUrl(query: string): string {
    return `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  }

  protected parseResults(html: string, limit: number): SearchResult[] {
    return extractGenericHtmlResults(html, limit, ["result-header", "heading"]);
  }
}

class BingSearchProvider extends HtmlSearchProvider {
  constructor() {
    super("bing");
  }

  protected buildUrl(query: string): string {
    return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  }

  protected parseResults(html: string, limit: number): SearchResult[] {
    return extractBingResults(html, limit);
  }
}

export function createSearchProvider(name: SearchProviderName): SearchProvider {
  switch (name) {
    case "disabled":
      return new DisabledSearchProvider();
    case "duckduckgo":
      return new DuckDuckGoSearchProvider();
    case "stack_overflow":
      return new StackOverflowSearchProvider();
    case "brave":
      return new BraveSearchProvider();
    case "bing":
      return new BingSearchProvider();
  }
}

export function normalizeSearchProviderName(value: unknown): SearchProviderName | undefined {
  return typeof value === "string"
    ? SEARCH_PROVIDER_NAMES.find((candidate) => candidate === value.trim().toLowerCase())
    : undefined;
}

export function extractDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) && results.length < limit) {
    const anchorIndex = match.index + match[0].length;
    const snippet = extractNearbySnippet(html, anchorIndex, /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</i);
    const url = resolveDuckDuckGoHref(match[1] ?? "");

    if (!url) {
      continue;
    }

    pushResult(results, {
      title: cleanText(match[2] ?? ""),
      url,
      snippet
    });
  }

  return results;
}

export function extractStackOverflowResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a[^>]+href="([^"]*\/questions\/[^"]+)"[^>]*class="[^"]*s-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) && results.length < limit) {
    const anchorIndex = match.index + match[0].length;
    const snippet = extractNearbySnippet(
      html,
      anchorIndex,
      /class="[^"]*s-post-summary--content-excerpt[^"]*"[^>]*>([\s\S]*?)</i
    ) || extractNearbySnippet(html, anchorIndex, /class="[^"]*excerpt[^"]*"[^>]*>([\s\S]*?)</i);

    pushResult(results, {
      title: cleanText(match[2] ?? ""),
      url: absolutizeUrl("https://stackoverflow.com", match[1] ?? ""),
      snippet
    });
  }

  return results;
}

function extractBingResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(html)) && results.length < limit) {
    const block = match[1] ?? "";
    const anchor = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = extractFirst(block, /<p[^>]*>([\s\S]*?)<\/p>/i);

    if (!anchor) {
      continue;
    }

    pushResult(results, {
      title: cleanText(anchor[2] ?? ""),
      url: anchor[1] ?? "",
      snippet: cleanText(snippet)
    });
  }

  return results;
}

function extractGenericHtmlResults(html: string, limit: number, classHints: string[]): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a([^>]+)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) && results.length < limit) {
    const attrs = match[1] ?? "";
    const title = cleanText(match[2] ?? "");
    const href = extractAttribute(attrs, "href");
    const className = extractAttribute(attrs, "class");

    if (!href || !title || href.startsWith("/") || href.startsWith("#")) {
      continue;
    }

    if (!classHints.some((hint) => className.includes(hint))) {
      continue;
    }

    const snippet = extractNearbySnippet(html, match.index + match[0].length, /<p[^>]*>([\s\S]*?)<\/p>/i);
    pushResult(results, {
      title,
      url: href,
      snippet
    });
  }

  return results;
}

function resolveDuckDuckGoHref(rawHref: string): string | null {
  if (!rawHref) {
    return null;
  }

  const href = rawHref.startsWith("//") ? `https:${rawHref}` : rawHref;

  try {
    const parsed = new URL(href, "https://duckduckgo.com");

    if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname === "/l/") {
      return parsed.searchParams.get("uddg");
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function extractNearbySnippet(html: string, startIndex: number, pattern: RegExp): string {
  const slice = html.slice(startIndex, startIndex + 1600);
  return cleanText(extractFirst(slice, pattern));
}

function extractFirst(value: string, pattern: RegExp): string {
  const match = value.match(pattern);
  return match?.[1] ?? "";
}

function extractAttribute(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return decodeHtmlEntities(match?.[1] ?? "");
}

function absolutizeUrl(origin: string, href: string): string {
  try {
    return new URL(href, origin).toString();
  } catch {
    return href;
  }
}

function pushResult(target: SearchResult[], result: SearchResult): void {
  if (!result.title || !result.url) {
    return;
  }

  if (target.some((entry) => entry.url === result.url)) {
    return;
  }

  target.push({
    title: result.title,
    url: result.url,
    snippet: result.snippet || "(no snippet)"
  });
}

function cleanText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isNaN(code) ? "" : String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isNaN(code) ? "" : String.fromCodePoint(code);
    });
}
