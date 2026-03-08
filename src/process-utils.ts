import { spawn } from "node:child_process";

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface BaseOptions {
  cwd: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_BYTES = 256_000;

export async function runExecFile(
  file: string,
  args: string[],
  options: BaseOptions
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

export async function runShellCommand(command: string, options: BaseOptions): Promise<CommandOutput> {
  const shell = resolveShell();
  return runExecFile(shell.file, [...shell.args, command], options);
}

function resolveShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c"]
    };
  }

  const fallbackShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  return {
    file: process.env.SHELL?.trim() || fallbackShell,
    args: ["-c"]
  };
}

function collect(current: string, addition: string): string {
  const next = current + addition;
  return next.length > MAX_CAPTURED_BYTES ? next.slice(0, MAX_CAPTURED_BYTES) : next;
}
