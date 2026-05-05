import {
  GithubRateLimitedError,
  type GithubRateLimitKind,
} from "../../domain/errors/github-rate-limited-error.js";

/**
 * Sink for daemon-level rate-limit pauses. Production wires this to
 * `RateLimitStateStore.pause("github", pausedUntil)`. The wrapper writes a
 * pause whenever it observes a rate-limit signal — both proactively
 * (`X-RateLimit-Remaining` below threshold) and reactively (`Retry-After`
 * exceeds the inline retry budget). Pauses are best-effort: a sink throw
 * is swallowed with a warning so the caller's request still aborts
 * cleanly via `GithubRateLimitedError`.
 */
export interface GithubRateLimitPause {
  pause: (pausedUntil: number) => Promise<void>;
}

export interface GithubFetchOptions {
  pauseSink?: GithubRateLimitPause;
  /**
   * Trip the daemon-level pause as soon as `X-RateLimit-Remaining` drops
   * below this. Default 500. Sized so an in-flight task with several
   * remaining GitHub calls finishes before the pause kicks in for new
   * tasks. The current request is NOT failed by a proactive trip — only
   * future tasks are deferred.
   */
  proactiveThreshold?: number;
  /**
   * Retry-After windows at or below this trigger an in-process sleep +
   * one-shot retry. Longer windows surface as `GithubRateLimitedError`
   * so the daemon can pause and requeue rather than holding the slot.
   * Default 60_000 ms.
   */
  inlineRetryThresholdMs?: number;
  /**
   * Floor for the daemon pause window. Used when Retry-After is shorter
   * than this (proactive trip) or neither header is available. Default
   * 30 minutes — primary resets every hour, so 30 min is a single
   * self-correcting check cycle.
   */
  cooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

interface ResolvedOptions {
  pauseSink: GithubRateLimitPause | undefined;
  proactiveThreshold: number;
  inlineRetryThresholdMs: number;
  cooldownMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
}

const DEFAULT_PROACTIVE_THRESHOLD = 500;
const DEFAULT_INLINE_RETRY_THRESHOLD_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export interface GithubFetcher {
  request(url: string, init?: RequestInit): Promise<Response>;
}

export function createGithubFetcher(
  options?: GithubFetchOptions,
): GithubFetcher {
  const cfg: ResolvedOptions = {
    pauseSink: options?.pauseSink,
    proactiveThreshold:
      options?.proactiveThreshold ?? DEFAULT_PROACTIVE_THRESHOLD,
    inlineRetryThresholdMs:
      options?.inlineRetryThresholdMs ?? DEFAULT_INLINE_RETRY_THRESHOLD_MS,
    cooldownMs: options?.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    now: options?.now ?? (() => Date.now()),
    sleep:
      options?.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    fetchImpl: options?.fetchImpl ?? fetch,
  };

  return {
    request: (url, init) => doRequest(url, init, cfg, 0),
  };
}

async function doRequest(
  url: string,
  init: RequestInit | undefined,
  cfg: ResolvedOptions,
  attempt: number,
): Promise<Response> {
  const response = await cfg.fetchImpl(url, init ?? {});
  await maybeProactivePause(response, cfg);

  if (!isRateLimitResponse(response)) {
    return response;
  }

  const retryAfterMs = parseRetryAfterMs(response, cfg.now);
  const kind = inferKind(response);

  if (retryAfterMs <= cfg.inlineRetryThresholdMs && attempt === 0) {
    await cfg.sleep(Math.max(retryAfterMs, 0));
    return doRequest(url, init, cfg, attempt + 1);
  }

  const pausedUntil = cfg.now() + Math.max(retryAfterMs, cfg.cooldownMs);
  await safePause(cfg.pauseSink, pausedUntil);
  throw new GithubRateLimitedError({ kind, retryAfterMs, pausedUntil });
}

async function maybeProactivePause(
  response: Response,
  cfg: ResolvedOptions,
): Promise<void> {
  const remaining = numberHeader(response.headers.get("x-ratelimit-remaining"));
  if (remaining === undefined || remaining >= cfg.proactiveThreshold) {
    return;
  }
  const resetEpochS = numberHeader(response.headers.get("x-ratelimit-reset"));
  const pausedUntil =
    resetEpochS !== undefined
      ? Math.max(resetEpochS * 1000, cfg.now() + cfg.cooldownMs)
      : cfg.now() + cfg.cooldownMs;
  await safePause(cfg.pauseSink, pausedUntil);
}

// GitHub returns rate-limit signals on either 429 (most endpoints +
// secondary/abuse) or 403 (some legacy endpoints when remaining hits 0).
// We detect both: status 429, OR status 403 with explicit rate-limit
// headers. Other 4xx responses fall through to the caller unchanged.
function isRateLimitResponse(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  if (response.status === 403) {
    const remaining = numberHeader(
      response.headers.get("x-ratelimit-remaining"),
    );
    if (remaining === 0) {
      return true;
    }
    if (response.headers.get("retry-after") !== null) {
      return true;
    }
  }
  return false;
}

function inferKind(response: Response): GithubRateLimitKind {
  const remaining = numberHeader(response.headers.get("x-ratelimit-remaining"));
  // Primary: hourly bucket exhausted (remaining hit 0). Secondary: abuse
  // detection — typically still has remaining > 0 but a Retry-After.
  return remaining === 0 ? "primary" : "secondary";
}

function parseRetryAfterMs(
  response: Response,
  now: () => number,
): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const httpDate = Date.parse(retryAfter);
    if (Number.isFinite(httpDate)) {
      return Math.max(0, httpDate - now());
    }
  }
  const resetEpochS = numberHeader(response.headers.get("x-ratelimit-reset"));
  if (resetEpochS !== undefined) {
    return Math.max(0, resetEpochS * 1000 - now());
  }
  return 0;
}

function numberHeader(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function safePause(
  sink: GithubRateLimitPause | undefined,
  pausedUntil: number,
): Promise<void> {
  if (sink === undefined) {
    return;
  }
  try {
    await sink.pause(pausedUntil);
  } catch (error) {
    console.warn(
      `[github-fetch] pause sink threw, ignoring: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
