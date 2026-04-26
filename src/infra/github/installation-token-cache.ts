export interface InstallationTokenCacheOptions {
  bufferMs?: number;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const DEFAULT_BUFFER_MS = 60 * 1000;

export class InstallationTokenCache {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly installationIds = new Map<string, string>();
  private readonly bufferMs: number;
  private readonly now: () => number;

  constructor(options: InstallationTokenCacheOptions = {}) {
    this.bufferMs = options.bufferMs ?? DEFAULT_BUFFER_MS;
    this.now = options.now ?? (() => Date.now());
  }

  getInstallationId(repoKey: string): string | undefined {
    return this.installationIds.get(repoKey);
  }

  setInstallationId(repoKey: string, installationId: string): void {
    this.installationIds.set(repoKey, installationId);
  }

  getToken(installationId: string): string | undefined {
    const entry = this.tokens.get(installationId);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt - this.bufferMs <= this.now()) {
      this.tokens.delete(installationId);
      return undefined;
    }

    return entry.token;
  }

  setToken(installationId: string, token: string, expiresAt: number): void {
    this.tokens.set(installationId, { token, expiresAt });
  }
}
