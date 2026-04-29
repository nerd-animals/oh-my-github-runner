import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CleanupToolArtifacts } from "../../domain/ports/tool-artifact-cleaner.js";

export function encodeProjectsDirName(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ClaudeProjectsCleanerFs {
  rm: (
    target: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
  stat: (target: string) => Promise<unknown>;
}

export interface ClaudeProjectsCleanerOptions {
  workspacesDir: string;
  claudeHome: string;
  fs?: ClaudeProjectsCleanerFs;
}

export function createClaudeProjectsCleaner(
  options: ClaudeProjectsCleanerOptions,
): CleanupToolArtifacts {
  const fs: ClaudeProjectsCleanerFs = options.fs ?? { rm, stat };
  const projectsDir = path.join(options.claudeHome, "projects");
  const workspacesDir = path.resolve(options.workspacesDir);
  const workspacesPrefix = workspacesDir + path.sep;
  const expectedNamePrefix = encodeProjectsDirName(workspacesDir) + "-";

  return async (workspacePath: string): Promise<void> => {
    const resolvedWorkspace = path.resolve(workspacePath);

    if (
      resolvedWorkspace === workspacesDir ||
      !resolvedWorkspace.startsWith(workspacesPrefix)
    ) {
      console.debug("claude-projects-cleaner: skip", {
        reason: "outside-workspaces",
        workspacePath,
      });
      return;
    }

    const encodedName = encodeProjectsDirName(resolvedWorkspace);

    if (!encodedName.startsWith(expectedNamePrefix)) {
      console.debug("claude-projects-cleaner: skip", {
        reason: "prefix-mismatch",
        workspacePath,
      });
      return;
    }

    if (encodedName.includes(path.sep)) {
      console.debug("claude-projects-cleaner: skip", {
        reason: "sep-after-encode",
        workspacePath,
      });
      return;
    }

    const target = path.join(projectsDir, encodedName);

    if (path.dirname(target) !== projectsDir) {
      console.debug("claude-projects-cleaner: skip", {
        reason: "dirname-mismatch",
        workspacePath,
      });
      return;
    }

    try {
      await fs.stat(target);
    } catch {
      return;
    }

    await fs.rm(target, { recursive: true, force: true });
  };
}
