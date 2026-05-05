import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GithubRateLimitedError } from "../../src/domain/errors/github-rate-limited-error.js";
import { createGithubFetcher } from "../../src/infra/github/github-fetch.js";

interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function makeResponse(spec: ScriptedResponse): Response {
  return new Response(spec.body ?? "", {
    status: spec.status,
    headers: spec.headers ?? {},
  });
}

function makeFetchImpl(
  responses: ScriptedResponse[],
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    const spec = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (spec === undefined) {
      throw new Error("scripted fetch ran out of responses");
    }
    return makeResponse(spec);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeClock(initialMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = initialMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createGithubFetcher", () => {
  test("returns the response unchanged when remaining is above the proactive threshold", async () => {
    const { fetchImpl } = makeFetchImpl([
      {
        status: 200,
        headers: { "x-ratelimit-remaining": "4900", "x-ratelimit-reset": "9999" },
      },
    ]);
    const pauses: number[] = [];
    const fetcher = createGithubFetcher({
      pauseSink: { pause: async (until) => void pauses.push(until) },
      proactiveThreshold: 500,
      fetchImpl,
    });
    const res = await fetcher.request("https://api/x");
    assert.equal(res.status, 200);
    assert.deepEqual(pauses, []);
  });

  test("trips a daemon pause when remaining drops below the proactive threshold (uses reset epoch)", async () => {
    const clock = makeClock(1_000_000);
    const resetEpochS = 1_500; // 1_500_000 ms
    const { fetchImpl } = makeFetchImpl([
      {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "100",
          "x-ratelimit-reset": String(resetEpochS),
        },
      },
    ]);
    const pauses: number[] = [];
    const fetcher = createGithubFetcher({
      pauseSink: { pause: async (until) => void pauses.push(until) },
      proactiveThreshold: 500,
      cooldownMs: 60_000,
      now: clock.now,
      fetchImpl,
    });
    const res = await fetcher.request("https://api/x");
    assert.equal(res.status, 200, "the current request itself must succeed");
    assert.equal(pauses.length, 1);
    // pausedUntil = max(reset_ms, now + cooldown). reset_ms = 1_500_000,
    // now + cooldown = 1_060_000 → max is reset_ms.
    assert.equal(pauses[0], 1_500_000);
  });

  test("falls back to now+cooldown when reset header is missing on a proactive trip", async () => {
    const clock = makeClock(2_000_000);
    const { fetchImpl } = makeFetchImpl([
      { status: 200, headers: { "x-ratelimit-remaining": "10" } },
    ]);
    const pauses: number[] = [];
    const fetcher = createGithubFetcher({
      pauseSink: { pause: async (until) => void pauses.push(until) },
      proactiveThreshold: 500,
      cooldownMs: 30 * 60_000,
      now: clock.now,
      fetchImpl,
    });
    await fetcher.request("https://api/x");
    assert.equal(pauses[0], 2_000_000 + 30 * 60_000);
  });

  test("inline retries a 429 with short Retry-After exactly once", async () => {
    let slept = 0;
    const { fetchImpl, calls } = makeFetchImpl([
      { status: 429, headers: { "retry-after": "5" } },
      { status: 200 },
    ]);
    const fetcher = createGithubFetcher({
      inlineRetryThresholdMs: 60_000,
      sleep: async (ms) => {
        slept = ms;
      },
      fetchImpl,
    });
    const res = await fetcher.request("https://api/x");
    assert.equal(res.status, 200);
    assert.equal(slept, 5_000);
    assert.equal(calls.length, 2);
  });

  test("does not retry a second time even if the second attempt also rate-limits", async () => {
    const { fetchImpl, calls } = makeFetchImpl([
      { status: 429, headers: { "retry-after": "1" } },
      { status: 429, headers: { "retry-after": "1" } },
    ]);
    const fetcher = createGithubFetcher({
      inlineRetryThresholdMs: 60_000,
      cooldownMs: 30 * 60_000,
      sleep: async () => {},
      fetchImpl,
    });
    await assert.rejects(
      fetcher.request("https://api/x"),
      GithubRateLimitedError,
    );
    assert.equal(calls.length, 2, "must not retry beyond the first one-shot");
  });

  test("throws GithubRateLimitedError with secondary kind on a long Retry-After 429", async () => {
    const clock = makeClock(5_000_000);
    const { fetchImpl, calls } = makeFetchImpl([
      {
        status: 429,
        headers: {
          "retry-after": "3600",
          "x-ratelimit-remaining": "4900",
        },
      },
    ]);
    const pauses: number[] = [];
    const fetcher = createGithubFetcher({
      pauseSink: { pause: async (u) => void pauses.push(u) },
      inlineRetryThresholdMs: 60_000,
      cooldownMs: 30 * 60_000,
      now: clock.now,
      sleep: async () => {},
      fetchImpl,
    });

    await assert.rejects(
      fetcher.request("https://api/x"),
      (error: unknown) => {
        assert.ok(error instanceof GithubRateLimitedError);
        assert.equal(error.kind, "secondary");
        assert.equal(error.retryAfterMs, 3_600 * 1000);
        return true;
      },
    );
    assert.equal(calls.length, 1, "long Retry-After must not inline-retry");
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0], 5_000_000 + 3_600 * 1000);
  });

  test("classifies a 403 with remaining=0 as primary rate limit and throws", async () => {
    const clock = makeClock(0);
    const { fetchImpl } = makeFetchImpl([
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "120",
        },
      },
    ]);
    const fetcher = createGithubFetcher({
      inlineRetryThresholdMs: 60_000,
      cooldownMs: 30 * 60_000,
      now: clock.now,
      sleep: async () => {},
      fetchImpl,
    });

    await assert.rejects(
      fetcher.request("https://api/x"),
      (error: unknown) => {
        assert.ok(error instanceof GithubRateLimitedError);
        assert.equal(error.kind, "primary");
        // retryAfterMs = max(0, reset_ms - now) = 120_000
        assert.equal(error.retryAfterMs, 120_000);
        return true;
      },
    );
  });

  test("403 without rate-limit headers passes through unchanged", async () => {
    const { fetchImpl } = makeFetchImpl([
      { status: 403, body: "regular auth failure" },
    ]);
    const fetcher = createGithubFetcher({ fetchImpl });
    const res = await fetcher.request("https://api/x");
    assert.equal(res.status, 403);
  });

  test("parses HTTP-date Retry-After format", async () => {
    const clock = makeClock(0);
    // 30 seconds in the future
    const future = new Date(30_000).toUTCString();
    const { fetchImpl } = makeFetchImpl([
      { status: 429, headers: { "retry-after": future } },
      { status: 200 },
    ]);
    let slept = 0;
    const fetcher = createGithubFetcher({
      inlineRetryThresholdMs: 60_000,
      now: clock.now,
      sleep: async (ms) => {
        slept = ms;
      },
      fetchImpl,
    });
    await fetcher.request("https://api/x");
    // ms-precision date parsing → expect ~30_000
    assert.ok(Math.abs(slept - 30_000) <= 1_000, `unexpected slept=${slept}`);
  });

  test("a pause sink that throws does not mask the GithubRateLimitedError", async () => {
    const { fetchImpl } = makeFetchImpl([
      { status: 429, headers: { "retry-after": "9999" } },
    ]);
    const fetcher = createGithubFetcher({
      pauseSink: {
        pause: async () => {
          throw new Error("disk full");
        },
      },
      inlineRetryThresholdMs: 60_000,
      sleep: async () => {},
      fetchImpl,
    });
    await assert.rejects(
      fetcher.request("https://api/x"),
      GithubRateLimitedError,
    );
  });

  test("GithubRateLimitedError.pausedUntil is at least now+cooldown floor", async () => {
    const clock = makeClock(1_000_000);
    // Retry-After 0 means "we don't know"; fallback to cooldown floor.
    const { fetchImpl } = makeFetchImpl([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 429, headers: { "retry-after": "0" } },
    ]);
    let caught: unknown;
    const fetcher = createGithubFetcher({
      inlineRetryThresholdMs: 60_000,
      cooldownMs: 30 * 60_000,
      now: clock.now,
      sleep: async () => {},
      fetchImpl,
    });
    await fetcher.request("https://api/x").catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof GithubRateLimitedError);
    assert.equal(caught.pausedUntil, 1_000_000 + 30 * 60_000);
  });
});
