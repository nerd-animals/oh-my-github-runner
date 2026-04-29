import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RateLimitStateStoreOptions {
  filePath: string;
  now?: () => number;
}

interface RawState {
  pauses: Record<string, number>;
}

export class RateLimitStateStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(options: RateLimitStateStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
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
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RawState>;
      return { pauses: parsed.pauses ?? {} };
    } catch (error) {
      const isMissingFile =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT";

      if (isMissingFile) {
        return { pauses: {} };
      }

      throw error;
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
