import type { SearchProvider, SearchResult } from "./types.js";

export class DisabledSearchProvider implements SearchProvider {
  readonly name = "disabled";
  readonly configured = false;

  async search(_query: string, _limit: number): Promise<SearchResult[]> {
    throw new Error("web_search is disabled. Configure a search provider in the Vetala config to enable it.");
  }
}
