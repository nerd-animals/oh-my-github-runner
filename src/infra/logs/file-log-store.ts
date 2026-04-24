import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { LogStore } from "./log-store.js";

export interface FileLogStoreOptions {
  logsDir: string;
  retentionMs: number;
}

export class FileLogStore implements LogStore {
  constructor(private readonly options: FileLogStoreOptions) {}

  async write(taskId: string, message: string): Promise<void> {
    await mkdir(this.options.logsDir, { recursive: true });

    const line = `${new Date().toISOString()} ${message}\n`;
    await appendFile(this.getLogPath(taskId), line, "utf8");
  }

  async cleanupExpired(): Promise<void> {
    await mkdir(this.options.logsDir, { recursive: true });

    const entries = await readdir(this.options.logsDir, { withFileTypes: true });
    const expirationThreshold = Date.now() - this.options.retentionMs;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const fullPath = path.join(this.options.logsDir, entry.name);
      const metadata = await stat(fullPath);

      if (metadata.mtimeMs < expirationThreshold) {
        await rm(fullPath, { force: true });
      }
    }
  }

  private getLogPath(taskId: string): string {
    return path.join(this.options.logsDir, `${taskId}.log`);
  }
}
