#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("Usage: node scripts/smoke-installed-cli.mjs <tarball-or-directory>");
  }

  const tarballPath = resolveTarball(path.resolve(input));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "vetala-smoke-"));
  const installDir = path.join(tempRoot, "install");
  const workspaceDir = path.join(tempRoot, "workspace");
  const configDir = path.join(tempRoot, "config");
  const dataDir = path.join(tempRoot, "data");

  mkdirSync(installDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  console.error(`Smoke tarball: ${tarballPath}`);
  console.error(`Smoke root: ${tempRoot}`);

  runSync(...npmInvocation(["init", "-y"]), installDir);
  runSync(...npmInvocation(["install", tarballPath]), installDir);

  const cliEntry = path.join(installDir, "node_modules", "@vetala", "vetala", "dist", "src", "cli.js");
  console.error(`Smoke CLI entry: ${cliEntry}`);

  await runSmoke(cliEntry, workspaceDir, {
    ...process.env,
    APPDATA: configDir,
    LOCALAPPDATA: dataDir,
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    VETALA_SMOKE_TEST: "1",
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir
  });
}

function resolveTarball(targetPath) {
  if (statSync(targetPath).isFile()) {
    return targetPath;
  }

  if (!statSync(targetPath).isDirectory()) {
    throw new Error(`Unsupported path: ${targetPath}`);
  }

  const matches = findTarballs(targetPath).sort();

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one .tgz file in ${targetPath}, found ${matches.length}`);
  }

  return matches[0];
}

function findTarballs(rootDir) {
  const matches = [];
  const entries = readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findTarballs(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".tgz")) {
      matches.push(fullPath);
    }
  }

  return matches;
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return ["cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args]];
  }

  return ["npm", args];
}

function runSync(file, args, cwd) {
  console.error(`Running: ${file} ${args.join(" ")}`);
  const result = spawnSync(file, args, {
    cwd,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? "unknown"}: ${file} ${args.join(" ")}`);
  }
}

function runSmoke(cliEntry, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry], {
      cwd,
      env,
      stdio: "inherit"
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for Vetala smoke test to finish"));
    }, 30000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Vetala smoke test exited with code ${code ?? "unknown"}`));
    });
  });
}
