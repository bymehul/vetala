import path from "node:path";
import { stat } from "node:fs/promises";
import type { TaskKind } from "./deliberation.js";
import type { PathPolicy } from "./path-policy.js";

export interface TurnTargetContext {
  taskKind: TaskKind;
  explicitPaths: string[];
  explicitFiles: string[];
  explicitDirs: string[];
  preferredRoot: string | null;
}

export async function resolveTurnTargets(
  userInput: string,
  taskKind: TaskKind,
  pathPolicy: PathPolicy,
  workspaceRoot: string
): Promise<TurnTargetContext> {
  const allowedRoots = pathPolicy.allowedRoots();
  const files: string[] = [];
  const dirs: string[] = [];
  const seen = new Set<string>();

  for (const candidate of extractLikelyPaths(userInput)) {
    const resolved = pathPolicy.resolve(candidate);
    if (seen.has(resolved) || !isWithinAllowedRoots(resolved, allowedRoots)) {
      continue;
    }

    try {
      const info = await stat(resolved);
      seen.add(resolved);
      if (info.isFile()) {
        files.push(resolved);
      } else if (info.isDirectory()) {
        dirs.push(resolved);
      }
    } catch {
      // Ignore non-existent path-like strings.
    }
  }

  const explicitPaths = [...files, ...dirs];
  return {
    taskKind,
    explicitPaths,
    explicitFiles: files,
    explicitDirs: dirs,
    preferredRoot: determinePreferredRoot(files, dirs, workspaceRoot)
  };
}

export function extractLikelyPaths(input: string): string[] {
  const matches = input.match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set(matches)];
}

export function formatTurnTargetList(targets: string[], workspaceRoot: string): string {
  if (targets.length === 0) {
    return "(none)";
  }

  return targets
    .map((target) => {
      const relative = path.relative(workspaceRoot, target);
      if (!relative || relative.startsWith("..")) {
        return target;
      }
      return relative.split(path.sep).join("/");
    })
    .join(", ");
}

function determinePreferredRoot(files: string[], dirs: string[], workspaceRoot: string): string | null {
  if (files.length === 1 && dirs.length === 0) {
    return path.dirname(files[0]!);
  }
  if (dirs.length === 1 && files.length === 0) {
    return dirs[0]!;
  }

  const roots = [...dirs, ...files.map((file) => path.dirname(file))];
  if (roots.length === 0) {
    return null;
  }

  const common = commonAncestor(roots);
  if (!common) {
    return null;
  }

  const relative = path.relative(workspaceRoot, common);
  if (relative.startsWith("..")) {
    return null;
  }
  return common;
}

function commonAncestor(paths: string[]): string | null {
  if (paths.length === 0) {
    return null;
  }

  const splitPaths = paths.map((target) => path.resolve(target).split(path.sep).filter(Boolean));
  const shared: string[] = [];
  const first = splitPaths[0] ?? [];

  for (let i = 0; i < first.length; i += 1) {
    const segment = first[i];
    if (!segment) {
      break;
    }
    if (splitPaths.every((parts) => parts[i] === segment)) {
      shared.push(segment);
      continue;
    }
    break;
  }

  if (shared.length === 0) {
    return path.parse(path.resolve(paths[0]!)).root || null;
  }

  const root = path.parse(path.resolve(paths[0]!)).root;
  return path.join(root, ...shared);
}

function isWithinAllowedRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root);
    const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
    return target === normalizedRoot || target.startsWith(rootPrefix);
  });
}
