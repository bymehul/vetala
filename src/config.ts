import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { getProviderDefinition, listProviders, resolveProviderName } from "./providers/index.js";
import { normalizeSearchProviderName } from "./search-provider.js";
import type {
  EffectiveConfig,
  FileConfig,
  ProviderFileConfig,
  ProviderName,
  ProviderRuntimeConfig,
  ReasoningEffort,
  SearchProviderName
} from "./types.js";
import { ensureAppPaths } from "./xdg.js";

const DEFAULT_PROVIDER: ProviderName = "sarvam";
const DEFAULT_SEARCH_PROVIDER: SearchProviderName = "duckduckgo";

export async function loadConfig(): Promise<EffectiveConfig> {
  const paths = await ensureAppPaths();
  const fileConfig = await readFileConfig(paths.configFile);
  const defaultProvider =
    resolveProviderName(process.env.VETALA_PROVIDER ?? process.env.TATTVA_PROVIDER) ??
    normalizeProviderName(fileConfig.defaultProvider) ??
    DEFAULT_PROVIDER;

  const providers = Object.fromEntries(
    listProviders().map((provider) => [provider.name, resolveProviderRuntimeConfig(provider.name, fileConfig)])
  ) as Record<ProviderName, ProviderRuntimeConfig>;
  const active = providers[defaultProvider];

  return {
    defaultProvider,
    authMode: active.authMode,
    authValue: active.authValue,
    authFingerprint: active.authFingerprint,
    authSource: active.authSource,
    baseUrl: active.baseUrl,
    defaultModel: active.defaultModel,
    reasoningEffort:
      normalizeReasoningEffort(process.env.SARVAM_REASONING_EFFORT) ??
      normalizeReasoningEffort(fileConfig.reasoningEffort) ??
      null,
    configPath: paths.configFile,
    dataPath: paths.dataDir,
    searchProviderName:
      normalizeSearchProviderName(process.env.VETALA_SEARCH_PROVIDER ?? process.env.TATTVA_SEARCH_PROVIDER) ??
      normalizeSearchProviderName(fileConfig.searchProvider?.name) ??
      DEFAULT_SEARCH_PROVIDER,
    trustedWorkspaces: normalizeTrustedWorkspaces(fileConfig.trustedWorkspaces),
    providers
  };
}

export async function saveFileConfig(nextConfig: FileConfig): Promise<void> {
  const paths = await ensureAppPaths();
  await writeFile(paths.configFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

export async function saveDefaultModel(model: string): Promise<void> {
  await saveProviderDefaults("sarvam", model);
}

export async function saveChatDefaults(
  model: string,
  reasoningEffort: ReasoningEffort | null
): Promise<void> {
  await saveProviderDefaults("sarvam", model, { reasoningEffort });
}

export async function saveProviderDefaults(
  provider: ProviderName,
  model: string,
  options: {
    reasoningEffort?: ReasoningEffort | null;
  } = {}
): Promise<void> {
  await updateFileConfig((current) => {
    const next = setProviderFileConfig(current, provider, (profile) => ({
      ...profile,
      defaultModel: model
    }));

    return {
      ...next,
      defaultProvider: provider,
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {})
    };
  });
}

export async function saveAuthFingerprint(mode: "bearer" | "subscription_key", authValue: string): Promise<void> {
  await saveProviderAuthFingerprint("sarvam", mode, authValue);
}

export async function saveProviderAuthFingerprint(
  provider: ProviderName,
  mode: "bearer" | "subscription_key",
  authValue: string
): Promise<void> {
  await updateFileConfig((current) =>
    setProviderFileConfig(current, provider, (profile) => ({
      ...profile,
      savedAuth: {
        mode,
        sha256: sha256(authValue)
      }
    }))
  );
}

export async function savePersistentAuth(mode: "bearer" | "subscription_key", authValue: string): Promise<void> {
  await saveProviderPersistentAuth("sarvam", mode, authValue);
}

export async function saveProviderPersistentAuth(
  provider: ProviderName,
  mode: "bearer" | "subscription_key",
  authValue: string
): Promise<void> {
  await updateFileConfig((current) =>
    setProviderFileConfig(current, provider, (profile) => ({
      ...profile,
      savedAuth: {
        mode,
        sha256: sha256(authValue),
        value: authValue
      }
    }))
  );
}

export async function clearSavedAuth(): Promise<void> {
  await clearProviderSavedAuth("sarvam");
}

export async function clearProviderSavedAuth(provider: ProviderName): Promise<void> {
  await updateFileConfig((current) => setProviderFileConfig(current, provider, (profile) => removeSavedAuth(profile)));
}

export async function trustWorkspace(workspaceRoot: string): Promise<void> {
  await updateFileConfig((current) => {
    const trusted = normalizeTrustedWorkspaces(current.trustedWorkspaces);

    if (!trusted.includes(workspaceRoot)) {
      trusted.push(workspaceRoot);
      trusted.sort((left, right) => left.localeCompare(right));
    }

    return {
      ...current,
      trustedWorkspaces: trusted
    };
  });
}

export function isWorkspaceTrusted(config: EffectiveConfig, workspaceRoot: string): boolean {
  return config.trustedWorkspaces.includes(workspaceRoot);
}

export function withSessionAuth(
  config: EffectiveConfig,
  mode: "bearer" | "subscription_key",
  authValue: string
): EffectiveConfig {
  return withProviderSessionAuth(config, "sarvam", mode, authValue);
}

export function withProviderSessionAuth(
  config: EffectiveConfig,
  provider: ProviderName,
  mode: "bearer" | "subscription_key",
  authValue: string
): EffectiveConfig {
  return withResolvedAuth(config, provider, mode, authValue, "session");
}

export function withStoredAuth(
  config: EffectiveConfig,
  mode: "bearer" | "subscription_key",
  authValue: string
): EffectiveConfig {
  return withProviderStoredAuth(config, "sarvam", mode, authValue);
}

export function withProviderStoredAuth(
  config: EffectiveConfig,
  provider: ProviderName,
  mode: "bearer" | "subscription_key",
  authValue: string
): EffectiveConfig {
  return withResolvedAuth(config, provider, mode, authValue, "stored");
}

export function providerConfigFor(config: EffectiveConfig, provider: ProviderName): ProviderRuntimeConfig {
  return config.providers[provider];
}

function withResolvedAuth(
  config: EffectiveConfig,
  provider: ProviderName,
  mode: "bearer" | "subscription_key",
  authValue: string,
  authSource: "session" | "stored"
): EffectiveConfig {
  const profile: ProviderRuntimeConfig = {
    ...config.providers[provider],
    authMode: mode,
    authValue,
    authFingerprint: sha256(authValue),
    authSource
  };
  const providers = {
    ...config.providers,
    [provider]: profile
  };

  return applyActiveProvider(config, providers, config.defaultProvider);
}

async function readFileConfig(configPath: string): Promise<FileConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as FileConfig;
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }

    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function normalizeTrustedWorkspaces(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function normalizeProviderName(value: unknown): ProviderName | undefined {
  return typeof value === "string" ? resolveProviderName(value) : undefined;
}

function normalizeSavedAuth(value: ProviderFileConfig["savedAuth"]) {
  if (
    value &&
    (value.mode === "bearer" || value.mode === "subscription_key") &&
    typeof value.sha256 === "string" &&
    value.sha256.length > 0
  ) {
    return typeof value.value === "string" && value.value.length > 0
      ? {
          mode: value.mode,
          sha256: value.sha256,
          value: value.value
        }
      : {
          mode: value.mode,
          sha256: value.sha256
        };
  }

  return undefined;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function resolveProviderRuntimeConfig(provider: ProviderName, fileConfig: FileConfig): ProviderRuntimeConfig {
  const definition = getProviderDefinition(provider);
  const providerFile = providerFileConfig(fileConfig, provider);
  const env = definition.readEnv(process.env);
  const savedAuth = normalizeSavedAuth(providerFile.savedAuth);
  const savedAuthValue = savedAuth?.value;
  const authValue = env.authValue ?? savedAuthValue;
  const authMode = env.authMode ?? savedAuth?.mode ?? "missing";
  const authFingerprint = env.authValue ? sha256(env.authValue) : savedAuth?.sha256;
  const authSource = env.authValue
    ? "env"
    : savedAuthValue
      ? "stored"
      : savedAuth
        ? "stored_hash"
        : "missing";

  return {
    name: provider,
    baseUrl: env.baseUrl ?? providerFile.baseUrl ?? definition.defaultBaseUrl,
    defaultModel: env.defaultModel ?? providerFile.defaultModel ?? definition.defaultModel,
    authMode,
    authValue,
    authFingerprint,
    authSource
  };
}

function providerFileConfig(fileConfig: FileConfig, provider: ProviderName): ProviderFileConfig {
  const explicit = compactProviderFileConfig(fileConfig.providers?.[provider] ?? {});

  if (provider !== "sarvam") {
    return explicit;
  }

  return compactProviderFileConfig({
    ...(explicit.defaultModel ?? fileConfig.defaultModel
      ? { defaultModel: explicit.defaultModel ?? fileConfig.defaultModel }
      : {}),
    ...(explicit.baseUrl ?? fileConfig.baseUrl
      ? { baseUrl: explicit.baseUrl ?? fileConfig.baseUrl }
      : {}),
    ...(explicit.savedAuth ?? fileConfig.savedAuth
      ? { savedAuth: explicit.savedAuth ?? fileConfig.savedAuth }
      : {})
  });
}

function removeSavedAuth(profile: ProviderFileConfig): ProviderFileConfig {
  const { savedAuth: _savedAuth, ...rest } = profile;
  return rest;
}

function setProviderFileConfig(
  current: FileConfig,
  provider: ProviderName,
  mutate: (profile: ProviderFileConfig) => ProviderFileConfig
): FileConfig {
  const currentProviders = current.providers ?? {};
  const nextProfile = mutate(providerFileConfig(current, provider));
  const nextProviders = {
    ...currentProviders,
    [provider]: nextProfile
  };

  if (provider !== "sarvam") {
    return {
      ...current,
      providers: nextProviders
    };
  }

  const {
    defaultModel: _legacyDefaultModel,
    baseUrl: _legacyBaseUrl,
    savedAuth: _legacySavedAuth,
    ...rest
  } = current;

  return {
    ...rest,
    ...(nextProfile.defaultModel ? { defaultModel: nextProfile.defaultModel } : {}),
    ...(nextProfile.baseUrl ? { baseUrl: nextProfile.baseUrl } : {}),
    ...(nextProfile.savedAuth ? { savedAuth: nextProfile.savedAuth } : {}),
    providers: nextProviders
  };
}

async function updateFileConfig(mutator: (current: FileConfig) => FileConfig): Promise<void> {
  const paths = await ensureAppPaths();
  const current = await readFileConfig(paths.configFile);
  const next = mutator(current);
  await saveFileConfig(next);
}

function applyActiveProvider(
  current: EffectiveConfig,
  providers: Record<ProviderName, ProviderRuntimeConfig>,
  defaultProvider: ProviderName
): EffectiveConfig {
  const active = providers[defaultProvider];

  return {
    ...current,
    defaultProvider,
    providers,
    authMode: active.authMode,
    authValue: active.authValue,
    authFingerprint: active.authFingerprint,
    authSource: active.authSource,
    baseUrl: active.baseUrl,
    defaultModel: active.defaultModel
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactProviderFileConfig(profile: ProviderFileConfig): ProviderFileConfig {
  return {
    ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.savedAuth ? { savedAuth: profile.savedAuth } : {})
  };
}
