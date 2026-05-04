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

  constructor(options: RateLimitStateStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  async loadActivePauses(): Promise<Map<string, number>> {
    const state = await this.readState();
    const now = this.now();
    const active = new Map<string, number>();
    let mutated = false;

    for (const [tool, pausedUntil] of Object.entries(state.pauses)) {
      if (pausedUntil > now) {
        active.set(tool, pausedUntil);
      } else {
        mutated = true;
      }
    }

    if (mutated) {
      await this.writeState({ pauses: Object.fromEntries(active) });
    }

    return active;
  }

  async pause(tool: string, pausedUntil: number): Promise<void> {
    const state = await this.readState();
    state.pauses[tool] = pausedUntil;
    await this.writeState(state);
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
