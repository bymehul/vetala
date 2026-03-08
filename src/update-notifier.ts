import updateNotifier from "update-notifier";
import { APP_VERSION } from "./app-meta.js";
import { runExecFile, type CommandOutput } from "./process-utils.js";

const PACKAGE_NAME = "@vetala/vetala";
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;
const UPDATE_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const LAST_CHECK_KEY = "vetalaUpdateLastCheck";
const STORED_UPDATE_KEY = "vetalaStoredUpdate";
const SNOOZED_VERSION_KEY = "vetalaSnoozedVersion";
const SNOOZED_UNTIL_KEY = "vetalaSnoozedUntil";

export interface AvailableAppUpdate {
  currentVersion: string;
  latestVersion: string;
  installCommand: string;
  source: "cache" | "network";
}

export interface AppUpdateStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface AppUpdateNotifier {
  update?: {
    latest: string;
    current: string;
    type?: string;
    name: string;
  };
  config?: AppUpdateStore;
  fetchInfo(): Promise<{
    latest: string;
    current: string;
    type?: string;
    name: string;
  }>;
}

type AppUpdateInfo = NonNullable<AppUpdateNotifier["update"]>;

export interface CheckForAppUpdateOptions {
  currentVersion?: string;
  now?: Date;
  force?: boolean;
  notifier?: AppUpdateNotifier;
}

export interface SnoozeAppUpdateOptions {
  now?: Date;
  durationMs?: number;
  notifier?: AppUpdateNotifier;
}

export async function checkForAppUpdate(
  options: CheckForAppUpdateOptions = {}
): Promise<AvailableAppUpdate | null> {
  const now = options.now ?? new Date();
  const currentVersion = options.currentVersion ?? APP_VERSION;
  const notifier = options.notifier ?? createAppUpdateNotifier(currentVersion);
  const cachedUpdate = readStoredUpdate(notifier.config, currentVersion) ?? normalizeUpdateInfo(notifier.update);
  const cachedResult =
    cachedUpdate && hasAvailableUpdate(cachedUpdate) && !isSnoozed(notifier.config, cachedUpdate.latest, now)
      ? buildAvailableUpdate(currentVersion, cachedUpdate.latest, "cache")
      : null;
  const shouldRefresh = options.force || shouldRefreshUpdateInfo(notifier.config, now);

  if (!shouldRefresh) {
    return cachedResult;
  }

  try {
    const fetchedUpdate = normalizeUpdateInfo(await notifier.fetchInfo());
    recordUpdateCheck(notifier.config, now);

    if (!fetchedUpdate || !hasAvailableUpdate(fetchedUpdate)) {
      clearStoredUpdate(notifier.config);
      return null;
    }

    writeStoredUpdate(notifier.config, fetchedUpdate);

    if (isSnoozed(notifier.config, fetchedUpdate.latest, now)) {
      return null;
    }

    return buildAvailableUpdate(currentVersion, fetchedUpdate.latest, "network");
  } catch {
    return cachedResult;
  }
}

export async function snoozeAppUpdate(
  latestVersion: string,
  options: SnoozeAppUpdateOptions = {}
): Promise<void> {
  const notifier = options.notifier ?? createAppUpdateNotifier(APP_VERSION);
  const store = notifier.config;

  if (!store) {
    return;
  }

  const now = options.now ?? new Date();
  const durationMs = options.durationMs ?? UPDATE_SNOOZE_MS;

  store.set(SNOOZED_VERSION_KEY, latestVersion);
  store.set(SNOOZED_UNTIL_KEY, new Date(now.getTime() + durationMs).toISOString());
}

export async function installAppUpdate(latestVersion: string): Promise<CommandOutput> {
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  return runExecFile(
    npmExecutable,
    ["install", "-g", `${PACKAGE_NAME}@${latestVersion}`],
    {
      cwd: process.cwd(),
      timeoutMs: UPDATE_INSTALL_TIMEOUT_MS
    }
  );
}

function createAppUpdateNotifier(currentVersion: string): AppUpdateNotifier {
  return updateNotifier({
    pkg: {
      name: PACKAGE_NAME,
      version: currentVersion
    },
    updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
    shouldNotifyInNpmScript: true
  });
}

function buildAvailableUpdate(
  currentVersion: string,
  latestVersion: string,
  source: "cache" | "network"
): AvailableAppUpdate {
  return {
    currentVersion,
    latestVersion,
    installCommand: `npm install -g ${PACKAGE_NAME}@${latestVersion}`,
    source
  };
}

function normalizeUpdateInfo(value: unknown): AppUpdateInfo | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    latest?: unknown;
    current?: unknown;
    type?: unknown;
    name?: unknown;
  };

  if (typeof candidate.latest !== "string" || typeof candidate.current !== "string") {
    return null;
  }

  const normalized: AppUpdateInfo = {
    latest: candidate.latest,
    current: candidate.current,
    name: typeof candidate.name === "string" ? candidate.name : PACKAGE_NAME
  };

  if (typeof candidate.type === "string") {
    normalized.type = candidate.type;
  }

  return normalized;
}

function hasAvailableUpdate(update: AppUpdateInfo): boolean {
  return update.type !== "latest" && update.latest !== update.current;
}

function readStoredUpdate(store: AppUpdateStore | undefined, currentVersion: string): AppUpdateInfo | null {
  if (!store) {
    return null;
  }

  const stored = normalizeUpdateInfo(store.get(STORED_UPDATE_KEY));

  if (!stored || stored.current !== currentVersion || !hasAvailableUpdate(stored)) {
    return null;
  }

  return stored;
}

function writeStoredUpdate(store: AppUpdateStore | undefined, update: AppUpdateInfo): void {
  store?.set(STORED_UPDATE_KEY, update);
}

function clearStoredUpdate(store: AppUpdateStore | undefined): void {
  store?.delete(STORED_UPDATE_KEY);
}

function shouldRefreshUpdateInfo(store: AppUpdateStore | undefined, now: Date): boolean {
  if (!store) {
    return false;
  }

  const lastChecked = store.get(LAST_CHECK_KEY);

  if (typeof lastChecked !== "string") {
    return true;
  }

  const timestamp = Date.parse(lastChecked);
  return !Number.isFinite(timestamp) || now.getTime() - timestamp >= UPDATE_CHECK_INTERVAL_MS;
}

function recordUpdateCheck(store: AppUpdateStore | undefined, now: Date): void {
  store?.set(LAST_CHECK_KEY, now.toISOString());
}

function isSnoozed(store: AppUpdateStore | undefined, latestVersion: string, now: Date): boolean {
  if (!store) {
    return false;
  }

  const snoozedVersion = store.get(SNOOZED_VERSION_KEY);
  const snoozedUntil = store.get(SNOOZED_UNTIL_KEY);

  if (snoozedVersion !== latestVersion || typeof snoozedUntil !== "string") {
    return false;
  }

  const until = Date.parse(snoozedUntil);
  const active = Number.isFinite(until) && until > now.getTime();

  if (!active) {
    store.delete(SNOOZED_VERSION_KEY);
    store.delete(SNOOZED_UNTIL_KEY);
  }

  return active;
}
