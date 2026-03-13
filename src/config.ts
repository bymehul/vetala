import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProviderDefinition, listProviders, resolveProviderName } from "./providers/index.js";
import { normalizeSearchProviderName } from "./search-provider.js";
import type {
  ContextFileSettings,
  EffectiveConfig,
  FileConfig,
  HistoryPersistence,
  HistorySettings,
  MemoriesSettings,
  MemorySettings,
  ProviderFileConfig,
  ProviderName,
  ProviderSavedAuth,
  ProviderRuntimeConfig,
  ReasoningEffort,
  SearchProviderName
} from "./types.js";
import { ensureAppPaths } from "./xdg.js";

const DEFAULT_PROVIDER: ProviderName = "sarvam";
const DEFAULT_SEARCH_PROVIDER: SearchProviderName = "duckduckgo";
const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  recentMessageCount: 12,
  maxMemoryEvents: 10,
  maxPreviewLength: 140,
  maxReferencedFiles: 6
};
const DEFAULT_CONTEXT_FILES: ContextFileSettings = {
  maxFiles: 8,
  maxFileBytes: 4000,
  maxTotalBytes: 20000
};
const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  persistence: "save_all",
  maxBytes: null
};
const DEFAULT_MEMORIES_SETTINGS: MemoriesSettings = {
  enabled: true,
  useMemories: true,
  maxRolloutsPerStartup: 16,
  maxRolloutAgeDays: 30,
  minRolloutIdleHours: 6,
  maxRawMemoriesForConsolidation: 256,
  maxUnusedDays: 30,
  rolloutMaxChars: 20000,
  rawMemoryMaxChars: 8000,
  rolloutSummaryMaxChars: 2000,
  summaryMaxChars: 4000,
  extractModel: null,
  consolidationModel: null
};
const AUTH_KEY_FILE = "auth.key";
const AUTH_ENCRYPTION_VERSION = "v1";

let cachedAuthKey: Buffer | null = null;

export async function loadConfig(): Promise<EffectiveConfig> {
  const paths = await ensureAppPaths();
  const fileConfig = await readFileConfig(paths.configFile);
  const scrubbed = scrubFileConfig(fileConfig);
  if (scrubbed.changed) {
    await writeFile(paths.configFile, `${JSON.stringify(scrubbed.next, null, 2)}\n`, "utf8");
  }
  const normalizedConfig = scrubbed.next;
  const memory = normalizeMemorySettings(normalizedConfig.memory);
  const contextFiles = normalizeContextFileSettings(normalizedConfig.contextFiles);
  const history = normalizeHistorySettings(normalizedConfig.history);
  const memories = normalizeMemoriesSettings(normalizedConfig.memories);
  const defaultProvider =
    resolveProviderName(process.env.VETALA_PROVIDER ?? process.env.TATTVA_PROVIDER) ??
    normalizeProviderName(normalizedConfig.defaultProvider) ??
    DEFAULT_PROVIDER;

  const providerEntries = await Promise.all(
    listProviders().map(async (provider) => [
      provider.name,
      await resolveProviderRuntimeConfig(provider.name, normalizedConfig)
    ] as const)
  );
  const providers = Object.fromEntries(providerEntries) as Record<ProviderName, ProviderRuntimeConfig>;
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
      normalizeReasoningEffort(normalizedConfig.reasoningEffort) ??
      null,
    configPath: paths.configFile,
    dataPath: paths.dataDir,
    searchProviderName:
      normalizeSearchProviderName(process.env.VETALA_SEARCH_PROVIDER ?? process.env.TATTVA_SEARCH_PROVIDER) ??
      normalizeSearchProviderName(normalizedConfig.searchProvider?.name) ??
      DEFAULT_SEARCH_PROVIDER,
    trustedWorkspaces: normalizeTrustedWorkspaces(normalizedConfig.trustedWorkspaces),
    providers,
    memory,
    contextFiles,
    history,
    memories
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
  await saveProviderAuthFingerprint(provider, mode, authValue);
}

export async function saveStoredAuthValue(mode: "bearer" | "subscription_key", authValue: string): Promise<void> {
  await saveProviderStoredAuthValue("sarvam", mode, authValue);
}

export async function saveProviderStoredAuthValue(
  provider: ProviderName,
  mode: "bearer" | "subscription_key",
  authValue: string
): Promise<void> {
  const encrypted = await encryptAuthValue(authValue);
  await updateFileConfig((current) =>
    setProviderFileConfig(current, provider, (profile) => ({
      ...profile,
      savedAuth: {
        mode,
        sha256: sha256(authValue),
        encrypted
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
    const normalized: ProviderSavedAuth = {
      mode: value.mode,
      sha256: value.sha256
    };
    const encrypted = typeof (value as ProviderSavedAuth).encrypted === "string"
      ? (value as ProviderSavedAuth).encrypted
      : undefined;
    if (encrypted) {
      normalized.encrypted = encrypted;
    }
    return normalized;
  }

  return undefined;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeMemorySettings(value: FileConfig["memory"]): MemorySettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_MEMORY_SETTINGS;
  }

  return {
    recentMessageCount: normalizePositiveInt(value.recentMessageCount, DEFAULT_MEMORY_SETTINGS.recentMessageCount, 1, 64),
    maxMemoryEvents: normalizePositiveInt(value.maxMemoryEvents, DEFAULT_MEMORY_SETTINGS.maxMemoryEvents, 1, 64),
    maxPreviewLength: normalizePositiveInt(value.maxPreviewLength, DEFAULT_MEMORY_SETTINGS.maxPreviewLength, 40, 1000),
    maxReferencedFiles: normalizePositiveInt(value.maxReferencedFiles, DEFAULT_MEMORY_SETTINGS.maxReferencedFiles, 0, 64)
  };
}

function normalizeContextFileSettings(value: FileConfig["contextFiles"]): ContextFileSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_CONTEXT_FILES;
  }

  const maxFiles = normalizePositiveInt(value.maxFiles, DEFAULT_CONTEXT_FILES.maxFiles, 0, 64);
  const maxFileBytes = normalizePositiveInt(value.maxFileBytes, DEFAULT_CONTEXT_FILES.maxFileBytes, 200, 100000);
  const maxTotalBytes = normalizePositiveInt(value.maxTotalBytes, DEFAULT_CONTEXT_FILES.maxTotalBytes, maxFileBytes, 200000);

  return {
    maxFiles,
    maxFileBytes,
    maxTotalBytes: Math.max(maxFileBytes, maxTotalBytes)
  };
}

function normalizeHistorySettings(value: FileConfig["history"]): HistorySettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_HISTORY_SETTINGS;
  }

  return {
    persistence: normalizeHistoryPersistence(value.persistence),
    maxBytes: normalizeOptionalBytes(value.maxBytes)
  };
}

function normalizeMemoriesSettings(value: FileConfig["memories"]): MemoriesSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_MEMORIES_SETTINGS;
  }

  return {
    enabled: normalizeBoolean(value.enabled, DEFAULT_MEMORIES_SETTINGS.enabled),
    useMemories: normalizeBoolean(value.useMemories, DEFAULT_MEMORIES_SETTINGS.useMemories),
    maxRolloutsPerStartup: normalizePositiveInt(value.maxRolloutsPerStartup, DEFAULT_MEMORIES_SETTINGS.maxRolloutsPerStartup, 0, 1024),
    maxRolloutAgeDays: normalizePositiveInt(value.maxRolloutAgeDays, DEFAULT_MEMORIES_SETTINGS.maxRolloutAgeDays, 1, 3650),
    minRolloutIdleHours: normalizePositiveInt(value.minRolloutIdleHours, DEFAULT_MEMORIES_SETTINGS.minRolloutIdleHours, 0, 720),
    maxRawMemoriesForConsolidation: normalizePositiveInt(
      value.maxRawMemoriesForConsolidation,
      DEFAULT_MEMORIES_SETTINGS.maxRawMemoriesForConsolidation,
      1,
      2000
    ),
    maxUnusedDays: normalizePositiveInt(value.maxUnusedDays, DEFAULT_MEMORIES_SETTINGS.maxUnusedDays, 1, 3650),
    rolloutMaxChars: normalizePositiveInt(value.rolloutMaxChars, DEFAULT_MEMORIES_SETTINGS.rolloutMaxChars, 1000, 200000),
    rawMemoryMaxChars: normalizePositiveInt(value.rawMemoryMaxChars, DEFAULT_MEMORIES_SETTINGS.rawMemoryMaxChars, 200, 200000),
    rolloutSummaryMaxChars: normalizePositiveInt(value.rolloutSummaryMaxChars, DEFAULT_MEMORIES_SETTINGS.rolloutSummaryMaxChars, 200, 200000),
    summaryMaxChars: normalizePositiveInt(value.summaryMaxChars, DEFAULT_MEMORIES_SETTINGS.summaryMaxChars, 200, 200000),
    extractModel: normalizeOptionalString(value.extractModel),
    consolidationModel: normalizeOptionalString(value.consolidationModel)
  };
}

function normalizeHistoryPersistence(value: unknown): HistoryPersistence {
  if (value === "none") {
    return "none";
  }
  if (value === "save_all" || value === "save-all") {
    return "save_all";
  }
  return DEFAULT_HISTORY_SETTINGS.persistence;
}

async function resolveProviderRuntimeConfig(provider: ProviderName, fileConfig: FileConfig): Promise<ProviderRuntimeConfig> {
  const definition = getProviderDefinition(provider);
  const providerFile = providerFileConfig(fileConfig, provider);
  const env = definition.readEnv(process.env);
  const savedAuth = normalizeSavedAuth(providerFile.savedAuth);
  const storedAuthValue = savedAuth?.encrypted ? await decryptAuthValue(savedAuth.encrypted) : null;
  const authValue = env.authValue ?? storedAuthValue ?? undefined;
  const authMode = env.authMode ?? savedAuth?.mode ?? "missing";
  const authFingerprint = env.authValue
    ? sha256(env.authValue)
    : storedAuthValue
      ? sha256(storedAuthValue)
      : savedAuth?.sha256;
  const authSource = env.authValue
    ? "env"
    : storedAuthValue
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

async function loadAuthKey(): Promise<Buffer> {
  if (cachedAuthKey) {
    return cachedAuthKey;
  }

  const paths = await ensureAppPaths();
  const keyPath = path.join(paths.dataDir, AUTH_KEY_FILE);

  try {
    const raw = await readFile(keyPath, "utf8");
    const decoded = Buffer.from(raw.trim(), "base64");
    if (decoded.length === 32) {
      cachedAuthKey = decoded;
      return decoded;
    }
  } catch {
    // fall through to generate a new key
  }

  const key = randomBytes(32);
  await writeFile(keyPath, key.toString("base64"), { mode: 0o600 });
  cachedAuthKey = key;
  return key;
}

async function encryptAuthValue(value: string): Promise<string> {
  const key = await loadAuthKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    AUTH_ENCRYPTION_VERSION,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64")
  ].join(":");
}

async function decryptAuthValue(encoded: string): Promise<string | null> {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== AUTH_ENCRYPTION_VERSION) {
    return null;
  }

  try {
    const key = await loadAuthKey();
    const iv = Buffer.from(parts[1] ?? "", "base64");
    const ciphertext = Buffer.from(parts[2] ?? "", "base64");
    const tag = Buffer.from(parts[3] ?? "", "base64");

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

function compactProviderFileConfig(profile: ProviderFileConfig): ProviderFileConfig {
  const savedAuth = normalizeSavedAuth(profile.savedAuth);
  return {
    ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(savedAuth ? { savedAuth } : {})
  };
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function normalizeOptionalBytes(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return null;
  }
  return rounded;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function scrubFileConfig(fileConfig: FileConfig): { next: FileConfig; changed: boolean } {
  let changed = false;
  const next: FileConfig = { ...fileConfig };

  const stripValue = (savedAuth: ProviderSavedAuth | undefined) => {
    if (!savedAuth) {
      return savedAuth;
    }
    if (!("value" in (savedAuth as { value?: unknown }))) {
      return savedAuth;
    }
    const { value: _value, ...rest } = savedAuth as ProviderSavedAuth & { value?: string };
    changed = true;
    return rest;
  };

  if (fileConfig.savedAuth) {
    const cleaned = stripValue(fileConfig.savedAuth);
    if (cleaned !== fileConfig.savedAuth) {
      if (cleaned) {
        next.savedAuth = cleaned;
      } else {
        delete next.savedAuth;
      }
    }
  }

  if (fileConfig.providers) {
    let providersChanged = false;
    const nextProviders: Partial<Record<ProviderName, ProviderFileConfig>> = { ...fileConfig.providers };

    for (const [name, profile] of Object.entries(fileConfig.providers)) {
      if (!profile) {
        continue;
      }
      const cleaned = stripValue(profile.savedAuth);
      if (cleaned !== profile.savedAuth) {
        providersChanged = true;
        if (cleaned) {
          nextProviders[name as ProviderName] = { ...profile, savedAuth: cleaned };
        } else {
          const { savedAuth: _savedAuth, ...rest } = profile;
          nextProviders[name as ProviderName] = rest;
        }
      }
    }

    if (providersChanged) {
      next.providers = nextProviders;
      changed = true;
    }
  }

  return { next, changed };
}
