import type { RepoRef } from "../domain/task.js";

export class RepoAllowlist {
  private readonly entries: ReadonlySet<string>;

  constructor(repos: readonly string[]) {
    this.entries = new Set(repos.map((value) => value.trim().toLowerCase()));
  }

  isAllowed(repo: RepoRef): boolean {
    return this.entries.has(`${repo.owner}/${repo.name}`.toLowerCase());
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  list(): string[] {
    return [...this.entries];
  }

  static fromEnv(value: string | undefined): RepoAllowlist {
    if (value === undefined || value.length === 0) {
      return new RepoAllowlist([]);
    }

    const repos = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return new RepoAllowlist(repos);
  }
}
