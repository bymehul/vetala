import type { ChatCompletionRequest, ProviderName, ProviderRuntimeConfig } from "../types.js";

export interface ProviderDefinition {
  name: ProviderName;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  endpointPath: string;
  errorLabel: string;
  supportsReasoningEffort: boolean;
  suggestedModels: string[];
  auth: {
    defaultMode: "bearer" | "subscription_key";
    envVars: string[];
    inputLabel: string;
    helpText: string;
  };
  readEnv(env: NodeJS.ProcessEnv): {
    authMode: ProviderRuntimeConfig["authMode"] | undefined;
    authValue: string | undefined;
    baseUrl: string | undefined;
    defaultModel: string | undefined;
  };
  buildHeaders(authMode: ProviderRuntimeConfig["authMode"], authValue: string): Record<string, string>;
  buildBody(request: ChatCompletionRequest): Record<string, unknown>;
}

const PROVIDER_DEFINITIONS: Record<ProviderName, ProviderDefinition> = {
  sarvam: {
    name: "sarvam",
    label: "Sarvam",
    defaultBaseUrl: "https://api.sarvam.ai",
    defaultModel: "sarvam-105b",
    endpointPath: "/v1/chat/completions",
    errorLabel: "Sarvam API",
    supportsReasoningEffort: true,
    suggestedModels: [
      "sarvam-105b",
      "sarvam-105b-32k",
      "sarvam-30b",
      "sarvam-30b-16k"
    ],
    auth: {
      defaultMode: "subscription_key",
      envVars: ["SARVAM_API_KEY", "SARVAM_SUBSCRIPTION_KEY", "SARVAM_TOKEN"],
      inputLabel: "API key",
      helpText: "Sarvam accepts either an API subscription key or a bearer token."
    },
    readEnv(env) {
      if (env.SARVAM_TOKEN) {
        return {
          authMode: "bearer",
          authValue: env.SARVAM_TOKEN,
          baseUrl: env.SARVAM_BASE_URL,
          defaultModel: env.SARVAM_MODEL
        };
      }

      if (env.SARVAM_API_KEY) {
        return {
          authMode: "subscription_key",
          authValue: env.SARVAM_API_KEY,
          baseUrl: env.SARVAM_BASE_URL,
          defaultModel: env.SARVAM_MODEL
        };
      }

      if (env.SARVAM_SUBSCRIPTION_KEY) {
        return {
          authMode: "subscription_key",
          authValue: env.SARVAM_SUBSCRIPTION_KEY,
          baseUrl: env.SARVAM_BASE_URL,
          defaultModel: env.SARVAM_MODEL
        };
      }

      return {
        authMode: undefined,
        authValue: undefined,
        baseUrl: env.SARVAM_BASE_URL,
        defaultModel: env.SARVAM_MODEL
      };
    },
    buildHeaders(authMode, authValue) {
      return authMode === "bearer"
        ? { Authorization: `Bearer ${authValue}` }
        : { "api-subscription-key": authValue };
    },
    buildBody(request) {
      return {
        ...request,
        messages: request.messages
      };
    }
  },
  openrouter: {
    name: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api",
    defaultModel: "openai/gpt-4o-mini",
    endpointPath: "/v1/chat/completions",
    errorLabel: "OpenRouter API",
    supportsReasoningEffort: false,
    suggestedModels: [
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-haiku",
      "google/gemini-2.0-flash-001"
    ],
    auth: {
      defaultMode: "bearer",
      envVars: ["OPENROUTER_API_KEY"],
      inputLabel: "API key",
      helpText: "OpenRouter uses bearer authentication."
    },
    readEnv(env) {
      return {
        authMode: env.OPENROUTER_API_KEY ? "bearer" : undefined,
        authValue: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        defaultModel: env.OPENROUTER_MODEL
      };
    },
    buildHeaders(_authMode, authValue) {
      return {
        Authorization: `Bearer ${authValue}`
      };
    },
    buildBody(request) {
      const { reasoning_effort: _reasoningEffort, ...rest } = request;
      return {
        ...rest,
        messages: request.messages
      };
    }
  }
};

export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDER_DEFINITIONS) as ProviderName[]);

export function listProviders(): ProviderDefinition[] {
  return PROVIDER_NAMES.map((name) => PROVIDER_DEFINITIONS[name]);
}

export function getProviderDefinition(name: ProviderName): ProviderDefinition {
  return PROVIDER_DEFINITIONS[name];
}

export function resolveProviderName(value: string | undefined): ProviderName | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return PROVIDER_NAMES.find((name) => name === normalized);
}
