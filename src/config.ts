import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ensureAppPaths } from "./xdg.js";
import type { EffectiveConfig, FileConfig, ReasoningEffort } from "./types.js";

const DEFAULT_BASE_URL = "https://api.sarvam.ai";
const DEFAULT_MODEL = "sarvam-105b";

export async function loadConfig(): Promise<EffectiveConfig> {
  const paths = await ensureAppPaths();
  const fileConfig = await readFileConfig(paths.configFile);
  const envAuth = readEnvAuth();
  const savedAuth = normalizeSavedAuth(fileConfig.savedAuth);
  const savedAuthValue = savedAuth?.value;
  const authValue = envAuth.authValue ?? savedAuthValue;
  const authMode = envAuth.authMode ?? savedAuth?.mode ?? "missing";
  const authFingerprint = envAuth.authValue
    ? sha256(envAuth.authValue)
    : savedAuth?.sha256;
  const authSource = envAuth.authValue
    ? "env"
    : savedAuthValue
      ? "stored"
      : savedAuth
      ? "stored_hash"
      : "missing";

  return {
    authMode,
    authValue,
    authFingerprint,
    authSource,
    baseUrl: process.env.SARVAM_BASE_URL ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: process.env.SARVAM_MODEL ?? fileConfig.defaultModel ?? DEFAULT_MODEL,
    reasoningEffort: normalizeReasoningEffort(process.env.SARVAM_REASONING_EFFORT) ?? normalizeReasoningEffort(fileConfig.reasoningEffort) ?? null,
    configPath: paths.configFile,
    dataPath: paths.dataDir,
    searchProviderName: fileConfig.searchProvider?.name ?? "disabled",
    trustedWorkspaces: normalizeTrustedWorkspaces(fileConfig.trustedWorkspaces)
  };
}

export async function saveFileConfig(nextConfig: FileConfig): Promise<void> {
  const paths = await ensureAppPaths();
  await writeFile(paths.configFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

export async function saveDefaultModel(model: string): Promise<void> {
  await updateFileConfig((current) => ({
    ...current,
    defaultModel: model
  }));
}

export async function saveChatDefaults(
  model: string,
  reasoningEffort: ReasoningEffort | null
): Promise<void> {
  await updateFileConfig((current) => ({
    ...current,
    defaultModel: model,
    reasoningEffort
  }));
}

export async function saveAuthFingerprint(mode: "bearer" | "subscription_key", authValue: string): Promise<void> {
  await updateFileConfig((current) => ({
    ...current,
    savedAuth: {
      mode,
      sha256: sha256(authValue)
    }
  }));
}

export async function savePersistentAuth(mode: "bearer" | "subscription_key", authValue: string): Promise<void> {
  await updateFileConfig((current) => ({
    ...current,
    savedAuth: {
      mode,
      sha256: sha256(authValue),
      value: authValue
    }
  }));
}

export async function clearSavedAuth(): Promise<void> {
  await updateFileConfig((current) => {
    const { savedAuth: _savedAuth, ...rest } = current;
    return rest;
  });
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
  return withResolvedAuth(config, mode, authValue, "session");
}

export function withStoredAuth(
  config: EffectiveConfig,
  mode: "bearer" | "subscription_key",
  authValue: string
): EffectiveConfig {
  return withResolvedAuth(config, mode, authValue, "stored");
}

function withResolvedAuth(
  config: EffectiveConfig,
  mode: "bearer" | "subscription_key",
  authValue: string,
  authSource: "session" | "stored"
): EffectiveConfig {
  return {
    ...config,
    authMode: mode,
    authValue,
    authFingerprint: sha256(authValue),
    authSource
  };
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

function normalizeSavedAuth(value: FileConfig["savedAuth"]) {
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

function readEnvAuth(): {
  authMode: "bearer" | "subscription_key" | undefined;
  authValue: string | undefined;
} {
  if (process.env.SARVAM_TOKEN) {
    return {
      authMode: "bearer",
      authValue: process.env.SARVAM_TOKEN
    };
  }

  if (process.env.SARVAM_API_KEY) {
    return {
      authMode: "subscription_key",
      authValue: process.env.SARVAM_API_KEY
    };
  }

  if (process.env.SARVAM_SUBSCRIPTION_KEY) {
    return {
      authMode: "subscription_key",
      authValue: process.env.SARVAM_SUBSCRIPTION_KEY
    };
  }

  return {
    authMode: undefined,
    authValue: undefined
  };
}

async function updateFileConfig(mutator: (current: FileConfig) => FileConfig): Promise<void> {
  const paths = await ensureAppPaths();
  const current = await readFileConfig(paths.configFile);
  const next = mutator(current);
  await saveFileConfig(next);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
