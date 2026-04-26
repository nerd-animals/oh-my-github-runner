import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Runtime } from "../../src/runtime.js";

describe("Runtime", () => {
  test("starts daemon then webhook server, and stops webhook before aborting daemon", async () => {
    const events: string[] = [];

    const runtime = new Runtime({
      daemon: {
        start: async (signal: AbortSignal) => {
          events.push("daemon:start");
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                events.push("daemon:abort-detected");
                setTimeout(() => {
                  events.push("daemon:drained");
                  resolve();
                }, 10);
              },
              { once: true },
            );
          });
        },
      },
      webhookServer: {
        start: async () => {
          events.push("webhook:start");
        },
        stop: async () => {
          events.push("webhook:stop");
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    assert.deepEqual(events, [
      "daemon:start",
      "webhook:start",
      "webhook:stop",
      "daemon:abort-detected",
      "daemon:drained",
    ]);
  });

  test("run completes the lifecycle when the stop signal aborts", async () => {
    const events: string[] = [];
    const abort = new AbortController();

    const runtime = new Runtime({
      daemon: {
        start: async (signal: AbortSignal) => {
          events.push("daemon:start");
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          events.push("daemon:exit");
        },
      },
      webhookServer: {
        start: async () => {
          events.push("webhook:start");
        },
        stop: async () => {
          events.push("webhook:stop");
        },
      },
    });

    const finished = runtime.run(abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await finished;

    assert.deepEqual(events, [
      "daemon:start",
      "webhook:start",
      "webhook:stop",
      "daemon:exit",
    ]);
  });

  test("run returns immediately if the stop signal is already aborted before start", async () => {
    const events: string[] = [];
    const abort = new AbortController();
    abort.abort();

    const runtime = new Runtime({
      daemon: {
        start: async (signal: AbortSignal) => {
          events.push("daemon:start");
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      webhookServer: {
        start: async () => {
          events.push("webhook:start");
        },
        stop: async () => {
          events.push("webhook:stop");
        },
      },
    });

    await runtime.run(abort.signal);

    assert.deepEqual(events, [
      "daemon:start",
      "webhook:start",
      "webhook:stop",
    ]);
  });
});
