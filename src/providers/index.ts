import type { ProviderName, ProviderRuntimeConfig } from "../types.js";
import { getProviderDefinition, listProviders, resolveProviderName } from "./catalog.js";
import { OpenAICompatibleChatClient, withSystemMessage } from "./openai-compatible-client.js";

export { withSystemMessage };
export { getProviderDefinition, listProviders, resolveProviderName };
export type { ProviderDefinition } from "./catalog.js";
export type { ChatProviderClient, ProviderRequestOptions } from "./openai-compatible-client.js";

export function createProviderClient(config: ProviderRuntimeConfig) {
  return new OpenAICompatibleChatClient(getProviderDefinition(config.name), config);
}

export function providerLabel(name: ProviderName): string {
  return getProviderDefinition(name).label;
}
