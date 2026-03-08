import os from "node:os";
import path from "node:path";
import type { RuntimeHostProfile } from "./types.js";

interface RuntimeProfileOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  release?: string;
  osVersion?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  columns?: number | null;
  rows?: number | null;
}

export function detectRuntimeHostProfile(options: RuntimeProfileOptions = {}): RuntimeHostProfile {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release = options.release ?? os.release();
  const osVersion = options.osVersion ?? safeOsVersion();
  const shell = detectShell(env);
  const terminalProgram = detectTerminalProgram(env);
  const terminalType = env.TERM ?? "unknown";
  const colorSupport = detectColorSupport(env, terminalType);
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const columns = options.columns ?? process.stdout.columns ?? null;
  const rows = options.rows ?? process.stdout.rows ?? null;

  return {
    platform,
    arch,
    release,
    osVersion,
    shell,
    terminalProgram,
    terminalType,
    colorSupport,
    stdinIsTTY,
    stdoutIsTTY,
    columns,
    rows
  };
}

export function formatRuntimeHostSummary(profile: RuntimeHostProfile): string {
  return `${platformLabel(profile.platform)} ${profile.arch} (${profile.release})`;
}

export function formatRuntimeTerminalSummary(profile: RuntimeHostProfile): string {
  const shellLabel = profile.shell;
  const terminalLabel =
    profile.terminalProgram === "unknown"
      ? profile.terminalType
      : `${profile.terminalProgram} / ${profile.terminalType}`;
  const sizeLabel =
    profile.stdoutIsTTY && profile.columns && profile.rows
      ? `${profile.columns}x${profile.rows}`
      : "non-interactive";

  return `${shellLabel} · ${terminalLabel} · ${sizeLabel}`;
}

function detectShell(env: NodeJS.ProcessEnv): string {
  return path.basename(env.SHELL ?? env.COMSPEC ?? env.PWSH_EXE ?? "unknown");
}

function detectTerminalProgram(env: NodeJS.ProcessEnv): string {
  if (env.TERM_PROGRAM) {
    return env.TERM_PROGRAM_VERSION
      ? `${env.TERM_PROGRAM} ${env.TERM_PROGRAM_VERSION}`
      : env.TERM_PROGRAM;
  }

  if (env.WT_SESSION) {
    return "Windows Terminal";
  }

  if (env.KITTY_PID) {
    return "kitty";
  }

  if (env.ALACRITTY_SOCKET || env.ALACRITTY_LOG) {
    return "Alacritty";
  }

  if (env.KONSOLE_VERSION) {
    return "Konsole";
  }

  if (env.GNOME_TERMINAL_SCREEN || env.VTE_VERSION) {
    return "VTE terminal";
  }

  if (env.TMUX) {
    return "tmux";
  }

  if (env.STY) {
    return "screen";
  }

  if (env.TERMINAL_EMULATOR) {
    return env.TERMINAL_EMULATOR;
  }

  return "unknown";
}

function detectColorSupport(env: NodeJS.ProcessEnv, terminalType: string): string {
  if (env.COLORTERM) {
    return env.COLORTERM;
  }

  if (terminalType.includes("truecolor")) {
    return "truecolor";
  }

  if (terminalType.includes("256color")) {
    return "256color";
  }

  return "basic";
}

function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function safeOsVersion(): string {
  try {
    return os.version();
  } catch {
    return os.release();
  }
}
