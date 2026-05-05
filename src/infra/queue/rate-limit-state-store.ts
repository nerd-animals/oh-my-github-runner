import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RateLimitStateStoreOptions {
  filePath: string;
  now?: () => number;
  warn?: (message: string) => void;
}

interface RawState {
  pauses: Record<string, number>;
}

export class RateLimitStateStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  // Serializes RMW cycles within one daemon process. The runner is a
  // single-process singleton (see src/index.ts). If that ever changes,
  // this needs to become a file-system lock.
  private mutex: Promise<void> = Promise.resolve();

  constructor(options: RateLimitStateStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  async loadActivePauses(): Promise<Map<string, number>> {
    const state = await this.readState();
    const now = this.now();
    const active = new Map<string, number>();

    for (const [tool, pausedUntil] of Object.entries(state.pauses)) {
      if (pausedUntil > now) {
        active.set(tool, pausedUntil);
      }
    }

    return active;
  }

  async pause(tool: string, pausedUntil: number): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      // Max-merge: a longer pausedUntil already on disk wins. Two writers
      // can race when a 429 from the wrapper writes a precise reset time
      // (e.g. now + 60 min from X-RateLimit-Reset) and the daemon's
      // handleRateLimit follows up with its standard cooldown floor
      // (e.g. now + 30 min). Without max-merge the coarser write would
      // shorten the precise pause and the next tick would re-trigger 429.
      // Stale past entries cannot interfere because loadActivePauses
      // filters them out and `pausedUntil > existing` is true for any
      // fresh future timestamp written over a stale past one.
      const existing = state.pauses[tool];
      state.pauses[tool] =
        existing !== undefined && existing > pausedUntil
          ? existing
          : pausedUntil;
      await this.writeState(state);
    });
  }

  /**
   * Removes any pause entry for `tool`. Returns the previous `pausedUntil`
   * timestamp if one was cleared, or `undefined` if no pause was tracked.
   * Idempotent: clearing a non-paused tool is a no-op.
   */
  async clear(tool: string): Promise<number | undefined> {
    return this.withLock(async () => {
      const state = await this.readState();
      const previous = state.pauses[tool];
      if (previous === undefined) {
        return undefined;
      }
      delete state.pauses[tool];
      await this.writeState(state);
      return previous;
    });
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn);
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readState(): Promise<RawState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return { pauses: {} };
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<RawState>;
      return { pauses: parsed.pauses ?? {} };
    } catch (error) {
      // Corrupt state.json (e.g. half-written after a non-graceful shutdown).
      // The pause map is reconstructable — the next 429 from any tool will
      // re-pause it — so resetting is safer than throwing on every tick.
      const reason = error instanceof Error ? error.message : String(error);
      this.warn(
        `[rate-limit-state] corrupt state file at ${this.filePath}: ${reason}; resetting to empty pauses`,
      );
      return { pauses: {} };
    }
  }

  private async writeState(state: RawState): Promise<void> {
    const dirPath = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;

    await mkdir(dirPath, { recursive: true });
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
