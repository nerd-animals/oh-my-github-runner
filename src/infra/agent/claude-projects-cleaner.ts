import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CleanupAgentArtifacts } from "../../domain/ports/agent-artifact-cleaner.js";

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
): CleanupAgentArtifacts {
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
      return;
    }

    const encodedName = encodeProjectsDirName(resolvedWorkspace);

    if (!encodedName.startsWith(expectedNamePrefix)) {
      return;
    }

    if (encodedName.includes(path.sep)) {
      return;
    }

    const target = path.join(projectsDir, encodedName);

    if (path.dirname(target) !== projectsDir) {
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
