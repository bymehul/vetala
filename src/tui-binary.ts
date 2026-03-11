import path from "node:path";

type SupportedPlatform = "linux" | "darwin" | "win32";
type SupportedArch = "x64" | "arm64";

type TuiTarget = {
  platform: SupportedPlatform;
  arch: SupportedArch;
  fileName: string;
};

const TUI_TARGETS: TuiTarget[] = [
  { platform: "linux", arch: "x64", fileName: "vetala-linux-x64" },
  { platform: "linux", arch: "arm64", fileName: "vetala-linux-arm64" },
  { platform: "darwin", arch: "x64", fileName: "vetala-darwin-x64" },
  { platform: "darwin", arch: "arm64", fileName: "vetala-darwin-arm64" },
  { platform: "win32", arch: "x64", fileName: "vetala-win32-x64.exe" },
  { platform: "win32", arch: "arm64", fileName: "vetala-win32-arm64.exe" }
];

export const BUNDLED_TUI_FILES = TUI_TARGETS.map((target) => path.posix.join("tui", target.fileName));

export function resolveBundledTuiFileName(platform: string, arch: string): string | null {
  const target = TUI_TARGETS.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  return target?.fileName ?? null;
}

export function resolveBundledTuiBinaryCandidates(
  projectRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): {
  preferredRelativePath: string | null;
  candidates: string[];
  supported: boolean;
} {
  const preferredFileName = resolveBundledTuiFileName(platform, arch);
  const legacyCandidates =
    platform === "win32"
      ? [path.join(projectRoot, "tui", "vetala.exe"), path.join(projectRoot, "tui", "vetala")]
      : [path.join(projectRoot, "tui", "vetala")];
  const candidates = preferredFileName
    ? [path.join(projectRoot, "tui", preferredFileName), ...legacyCandidates]
    : legacyCandidates;

  return {
    preferredRelativePath: preferredFileName ? path.posix.join("tui", preferredFileName) : null,
    candidates: [...new Set(candidates)],
    supported: preferredFileName !== null
  };
}

export function formatSupportedTuiTargets(): string {
  return TUI_TARGETS.map((target) => `${target.platform}/${target.arch}`).join(", ");
}
