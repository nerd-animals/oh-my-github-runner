/**
 * Thrown when a GitHub API call hits a rate limit that the in-process
 * retry/throttle layer chose not to handle inline (typically because
 * Retry-After exceeds the inline threshold). The daemon catches this at
 * the strategy boundary and converts it to an `ExecuteResult.rate_limited`
 * with `toolNames: ["github"]` so the task is requeued and every other
 * task defers until the cooldown expires.
 *
 * `kind` distinguishes:
 *   - "primary"   : exhausted the hourly quota (X-RateLimit-Remaining hit
 *                   the proactive threshold or 0).
 *   - "secondary" : abuse / secondary rate limit (429 with Retry-After,
 *                   not visible in X-RateLimit-Remaining).
 */
export type GithubRateLimitKind = "primary" | "secondary";

export class GithubRateLimitedError extends Error {
  readonly kind: GithubRateLimitKind;
  readonly retryAfterMs: number;
  /** Epoch ms at which the daemon should consider GitHub clear again. */
  readonly pausedUntil: number;

  constructor(input: {
    kind: GithubRateLimitKind;
    retryAfterMs: number;
    pausedUntil: number;
    message?: string;
  }) {
    super(
      input.message ??
        `GitHub ${input.kind} rate limit (retry-after ~${Math.round(
          input.retryAfterMs / 1000,
        )}s, pausedUntil=${new Date(input.pausedUntil).toISOString()})`,
    );
    this.name = "GithubRateLimitedError";
    this.kind = input.kind;
    this.retryAfterMs = input.retryAfterMs;
    this.pausedUntil = input.pausedUntil;
  }
}

export function isGithubRateLimitedError(
  error: unknown,
): error is GithubRateLimitedError {
  return error instanceof GithubRateLimitedError;
}
