import { spawn } from "node:child_process";
import stripAnsi from "strip-ansi";

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
  noPty?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_BYTES = 256_000;

let pty: any;
let Terminal: any;
let ptyLoaded = false;

async function loadPty() {
  if (ptyLoaded) return;
  ptyLoaded = true;
  try {
    // @ts-ignore: node-pty typings are not correctly exported for NodeNext
    const ptyMod = await import("@lydell/node-pty");
    pty = ptyMod.default || ptyMod;
    
    const xtermPkg = await import("@xterm/headless");
    Terminal = xtermPkg.default ? xtermPkg.default.Terminal : xtermPkg.Terminal;
  } catch (e) {
    // Ignore missing PTY dependencies
  }
}

export async function runExecFile(
  file: string,
  args: string[],
  options: BaseOptions
): Promise<CommandOutput> {
  if (options.signal?.aborted) {
    throw createAbortError();
  }

  await loadPty();

  if (pty && Terminal && !process.env.DISABLE_PTY && !options.noPty) {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let settled = false;
      
      const ptyProcess = pty.spawn(file, args, {
        cwd: options.cwd,
        env: process.env as Record<string, string>,
        cols: 120,
        rows: 40,
        name: 'xterm-256color'
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        ptyProcess.kill("SIGTERM");
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const resolveOnce = (output: CommandOutput) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(output);
      };

      const onAbort = () => {
        try {
          ptyProcess.kill("SIGTERM");
        } catch {
          // Best-effort shutdown.
        }
        rejectOnce(createAbortError());
      };

      options.signal?.addEventListener("abort", onAbort, { once: true });

      let stdoutRaw = "";

      ptyProcess.onData((data: string) => {
        stdoutRaw = collect(stdoutRaw, data);
      });

      ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal: number }) => {
        if (settled) {
          return;
        }

        try {
          const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
          terminal.write(stdoutRaw, () => {
            const buffer = terminal.buffer.active;
            const lines: string[] = [];
            for (let i = 0; i <= buffer.cursorY; i++) {
              const line = buffer.getLine(i);
              if (line) {
                lines.push(line.translateToString(true).trimEnd());
              }
            }
            
            let parsedStdout = lines.join("\n").replace(/\n+$/, "");
            parsedStdout = stripAnsi(parsedStdout);
            
            resolveOnce({
              stdout: parsedStdout,
              stderr: "", 
              exitCode,
              signal: signal as any || null,
              timedOut
            });
          });
        } catch (e) {
          resolveOnce({
            stdout: stripAnsi(stdoutRaw),
            stderr: "",
            exitCode,
            signal: signal as any || null,
            timedOut
          });
        }
      });
    });
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (output: CommandOutput) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(output);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      rejectOnce(createAbortError());
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      rejectOnce(error);
    });

    child.on("close", (exitCode, signal) => {
      resolveOnce({ 
        stdout: stripAnsi(stdout), 
        stderr: stripAnsi(stderr), 
        exitCode, 
        signal, 
        timedOut 
      });
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

  const fallbackShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return {
    file: process.env.SHELL?.trim() || fallbackShell,
    args: ["-c"]
  };
}

function collect(current: string, addition: string): string {
  const next = current + addition;
  return next.length > MAX_CAPTURED_BYTES ? next.slice(0, MAX_CAPTURED_BYTES) : next;
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
