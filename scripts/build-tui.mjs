#!/usr/bin/env node

import { rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALL_TARGETS = [
  { platform: "linux", arch: "x64", goos: "linux", goarch: "amd64", fileName: "vetala-linux-x64" },
  { platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64", fileName: "vetala-linux-arm64" },
  { platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64", fileName: "vetala-darwin-x64" },
  { platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64", fileName: "vetala-darwin-arm64" },
  { platform: "win32", arch: "x64", goos: "windows", goarch: "amd64", fileName: "vetala-win32-x64.exe" },
  { platform: "win32", arch: "arm64", goos: "windows", goarch: "arm64", fileName: "vetala-win32-arm64.exe" }
];

const buildAllTargets = process.argv.includes("--all");
const target = ALL_TARGETS.find((candidate) => candidate.platform === process.platform && candidate.arch === process.arch);

if (!buildAllTargets && !target) {
  console.error(`No TUI build target configured for ${process.platform}/${process.arch}.`);
  process.exit(1);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tuiDir = path.join(repoRoot, "tui");
const targets = buildAllTargets ? ALL_TARGETS : [target];

const goVersion = spawnSync("go", ["version"], {
  stdio: "inherit"
});

if (goVersion.status !== 0) {
  process.exit(goVersion.status ?? 1);
}

for (const candidate of targets) {
  rmSync(path.join(tuiDir, candidate.fileName), { force: true });
}

for (const candidate of targets) {
  console.error(`Building ${candidate.fileName} for ${candidate.platform}/${candidate.arch}`);

  const result = spawnSync("go", ["build", "-o", candidate.fileName, "."], {
    cwd: tuiDir,
    stdio: "inherit",
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: candidate.goos,
      GOARCH: candidate.goarch
    }
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
