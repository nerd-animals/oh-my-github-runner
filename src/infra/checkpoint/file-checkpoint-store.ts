import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  CheckpointEntry,
  CheckpointStore,
} from "../../domain/ports/checkpoint-store.js";

// Bumped only on schema changes. Reads of unknown versions return undefined
// (cache miss); the writer overwrites with the current version on the next
// success, so old data evaporates without an explicit migration.
const CHECKPOINT_VERSION = 1;

// Sibling of taskId-named directories. Picked outside any plausible taskId
// pattern so `sweep` can skip it explicitly.
const CORRUPT_DIR = "corrupt";

interface PersistedCheckpoint {
  version: number;
  stepKey: string;
  fingerprint: string;
  tool: string;
  succeededAt: string;
  stdout: string;
}

export interface FileCheckpointStoreOptions {
  dataDir: string;
  warn?: (message: string) => void;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// stepKey is strategy-authored and may contain path-unsafe characters
// (slashes, dots, ...). Hash to a fixed 16-hex-char filename so the on-disk
// layout is deterministic and safe regardless of the input.
function stepFilename(stepKey: string): string {
  return `${createHash("sha256").update(stepKey).digest("hex").slice(0, 16)}.json`;
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly dataDir: string;
  private readonly warn: (message: string) => void;

  constructor(options: FileCheckpointStoreOptions) {
    this.dataDir = options.dataDir;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  async read(
    taskId: string,
    stepKey: string,
  ): Promise<CheckpointEntry | undefined> {
    const filePath = path.join(this.dataDir, taskId, stepFilename(stepKey));

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.quarantine(taskId, stepKey, reason);
      return undefined;
    }

    if (!isPersistedCheckpoint(parsed)) {
      // Schema looks broken even if the file is valid JSON. Move it aside
      // so future reads don't keep tripping on it, but the toolkit just
      // sees a miss and recomputes — same outcome as a clean cold start.
      const reason = `checkpoint payload missing required fields`;
      await this.quarantine(taskId, stepKey, reason);
      return undefined;
    }

    if (parsed.version !== CHECKPOINT_VERSION) {
      // Forward-compatibility: unknown version => miss, no quarantine. The
      // next successful run overwrites with the current schema.
      return undefined;
    }

    return {
      stepKey: parsed.stepKey,
      fingerprint: parsed.fingerprint,
      tool: parsed.tool,
      succeededAt: parsed.succeededAt,
      stdout: parsed.stdout,
    };
  }

  async write(taskId: string, entry: CheckpointEntry): Promise<void> {
    const dir = path.join(this.dataDir, taskId);
    await mkdir(dir, { recursive: true });

    const target = path.join(dir, stepFilename(entry.stepKey));
    const tmp = `${target}.tmp`;

    const payload: PersistedCheckpoint = {
      version: CHECKPOINT_VERSION,
      stepKey: entry.stepKey,
      fingerprint: entry.fingerprint,
      tool: entry.tool,
      succeededAt: entry.succeededAt,
      stdout: entry.stdout,
    };

    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, target);
  }

  async drop(taskId: string): Promise<void> {
    const dir = path.join(this.dataDir, taskId);
    await rm(dir, { recursive: true, force: true });
  }

  async sweep(activeTaskIds: ReadonlySet<string>): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dataDir);
    } catch (error) {
      if (isMissingFile(error)) {
        return 0;
      }
      throw error;
    }

    let dropped = 0;
    for (const entry of entries) {
      if (entry === CORRUPT_DIR) {
        continue;
      }
      if (activeTaskIds.has(entry)) {
        continue;
      }
      const target = path.join(this.dataDir, entry);
      try {
        await rm(target, { recursive: true, force: true });
        dropped += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.warn(
          `[file-checkpoint-store] sweep failed to remove ${target}: ${reason}`,
        );
      }
    }
    return dropped;
  }

  private async quarantine(
    taskId: string,
    stepKey: string,
    reason: string,
  ): Promise<void> {
    const fromPath = path.join(this.dataDir, taskId, stepFilename(stepKey));
    const corruptDir = path.join(this.dataDir, CORRUPT_DIR, taskId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = stepFilename(stepKey).replace(/\.json$/, "");
    const toPath = path.join(corruptDir, `${baseName}.${stamp}.json`);

    try {
      await mkdir(corruptDir, { recursive: true });
      await rename(fromPath, toPath);
      this.warn(
        `[file-checkpoint-store] quarantined corrupt checkpoint ${fromPath} -> ${toPath}: ${reason}`,
      );
    } catch (moveError) {
      const moveReason =
        moveError instanceof Error ? moveError.message : String(moveError);
      this.warn(
        `[file-checkpoint-store] failed to quarantine ${fromPath}: ${moveReason} (original parse error: ${reason})`,
      );
    }
  }
}

function isPersistedCheckpoint(value: unknown): value is PersistedCheckpoint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    typeof v.stepKey === "string" &&
    typeof v.fingerprint === "string" &&
    typeof v.tool === "string" &&
    typeof v.succeededAt === "string" &&
    typeof v.stdout === "string"
  );
}
