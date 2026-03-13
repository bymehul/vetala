import os from "node:os";
import path from "node:path";
import { access, mkdir, rename } from "node:fs/promises";

const APP_NAME = "vetala";
const LEGACY_APP_NAME = "tattva";

export interface AppPaths {
  configDir: string;
  dataDir: string;
  sessionsDir: string;
  memoriesDir: string;
  rulesDir: string;
  snapshotsDir: string;
  logsDir: string;
  tasksDir: string;
  configFile: string;
  latestWorkspaceFile: string;
  historyFile: string;
}

export function getAppPaths(): AppPaths {
  return appPathsForName(APP_NAME);
}

function getLegacyAppPaths(): AppPaths {
  return appPathsForName(LEGACY_APP_NAME);
}

function appPathsForName(appName: string): AppPaths {
  const home = os.homedir();
  const { configHome, dataHome } = resolveAppHomes(home);
  const configDir = path.join(configHome, appName);
  const dataDir = path.join(dataHome, appName);

  return {
    configDir,
    dataDir,
    sessionsDir: path.join(dataDir, "sessions"),
    memoriesDir: path.join(dataDir, "memories"),
    rulesDir: path.join(dataDir, "rules"),
    snapshotsDir: path.join(dataDir, "snapshots"),
    logsDir: path.join(dataDir, "logs"),
    tasksDir: path.join(dataDir, "tasks"),
    configFile: path.join(configDir, "config.json"),
    latestWorkspaceFile: path.join(dataDir, "latest-workspaces.json"),
    historyFile: path.join(dataDir, "history.jsonl")
  };
}

function resolveAppHomes(home: string): { configHome: string; dataHome: string } {
  if (process.platform === "win32") {
    return {
      configHome: process.env.XDG_CONFIG_HOME ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      dataHome: process.env.XDG_DATA_HOME ?? process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    };
  }

  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    return {
      configHome: process.env.XDG_CONFIG_HOME ?? appSupport,
      dataHome: process.env.XDG_DATA_HOME ?? appSupport
    };
  }

  return {
    configHome: process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    dataHome: process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share")
  };
}

export async function ensureAppPaths(): Promise<AppPaths> {
  const paths = getAppPaths();
  await migrateLegacyAppPaths(getLegacyAppPaths(), paths);

  await Promise.all([
    mkdir(paths.configDir, { recursive: true }),
    mkdir(paths.dataDir, { recursive: true }),
    mkdir(paths.sessionsDir, { recursive: true }),
    mkdir(paths.memoriesDir, { recursive: true }),
    mkdir(paths.rulesDir, { recursive: true }),
    mkdir(paths.snapshotsDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.tasksDir, { recursive: true })
  ]);

  return paths;
}

async function migrateLegacyAppPaths(legacy: AppPaths, current: AppPaths): Promise<void> {
  await maybeRenamePath(legacy.configDir, current.configDir);
  await maybeRenamePath(legacy.dataDir, current.dataDir);
}

async function maybeRenamePath(source: string, target: string): Promise<void> {
  if (!await exists(source) || await exists(target)) {
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
