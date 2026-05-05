import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { createWebhookServer } from "../../src/infra/webhook/webhook-server.js";
import type {
  RunnerStatusSummary,
  RunnerToolEntry,
} from "../../src/services/runner-status-service.js";
import type { WebhookHandler } from "../../src/services/webhook-handler.js";

interface HandlerCall {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

interface HandlerStub {
  handler: WebhookHandler;
  calls: HandlerCall[];
}

function makeHandlerStub(
  responder: (
    body: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<{ status: number; body?: string }> = async () => ({
    status: 200,
    body: "ok",
  }),
): HandlerStub {
  const calls: HandlerCall[] = [];
  const handler = {
    handle: async (
      body: Buffer,
      headers: Record<string, string | string[] | undefined>,
    ) => {
      calls.push({ body, headers });
      return responder(body, headers);
    },
  } as unknown as WebhookHandler;

  return { handler, calls };
}

function makeStatusSummary(
  runners: RunnerToolEntry[] = [{ tool: "claude", status: "idle" }],
): RunnerStatusSummary {
  return {
    status: "ok",
    tasks: {
      queued: 1,
      running: 0,
      succeeded: 2,
      failed: 0,
      superseded: 0,
    },
    runners,
  };
}

async function withServer<T>(
  options: Parameters<typeof createWebhookServer>[0],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createWebhookServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("createWebhookServer", () => {
  test("GET /health returns 200 and { status: 'ok' } without invoking the webhook handler", async () => {
    const stub = makeHandlerStub();

    await withServer({ handler: stub.handler }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);

      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "application/json",
      );
      assert.deepEqual(await response.json(), { status: "ok" });
    });

    assert.equal(stub.calls.length, 0);
  });

  test("GET /health succeeds without HMAC headers or signed body", async () => {
    const stub = makeHandlerStub(async () => {
      throw new Error("handler must not be called");
    });

    await withServer({ handler: stub.handler }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`, { method: "GET" });
      assert.equal(response.status, 200);
    });
  });

  test("GET /status returns the summary from the injected provider", async () => {
    const stub = makeHandlerStub();
    const summary = makeStatusSummary([
      { tool: "claude", status: "busy" },
      { tool: "codex", status: "idle" },
    ]);

    await withServer(
      {
        handler: stub.handler,
        statusProvider: { getStatus: async () => summary },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/status`);

        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get("content-type"),
          "application/json",
        );
        assert.deepEqual(await response.json(), summary);
      },
    );

    assert.equal(stub.calls.length, 0);
  });

  test("GET /status returns 503 when the provider throws", async () => {
    const stub = makeHandlerStub();

    await withServer(
      {
        handler: stub.handler,
        statusProvider: {
          getStatus: async () => {
            throw new Error("queue store unreachable");
          },
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/status`);

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "unavailable" });
      },
    );
  });

  test("GET /status returns 503 when no provider is wired", async () => {
    const stub = makeHandlerStub();

    await withServer({ handler: stub.handler }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/status`);

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: "unavailable" });
    });
  });

  test("POST /webhook still routes the body and headers to the handler and reflects its result", async () => {
    const stub = makeHandlerStub(async () => ({ status: 202, body: "ok" }));

    await withServer({ handler: stub.handler }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "deliv-1",
        },
        body: "payload",
      });

      assert.equal(response.status, 202);
      assert.equal(await response.text(), "ok");
    });

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.body.toString("utf8"), "payload");
    assert.equal(stub.calls[0]?.headers["x-github-event"], "issues");
  });

  test("POST /github/webhooks still routes to the handler", async () => {
    const stub = makeHandlerStub();

    await withServer({ handler: stub.handler }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/github/webhooks`, {
        method: "POST",
        body: "payload",
      });

      assert.equal(response.status, 200);
    });

    assert.equal(stub.calls.length, 1);
  });

  test("GET /webhook and unknown paths return 404", async () => {
    const stub = makeHandlerStub();

    await withServer({ handler: stub.handler }, async (baseUrl) => {
      const getOnWebhook = await fetch(`${baseUrl}/webhook`);
      assert.equal(getOnWebhook.status, 404);

      const unknownPath = await fetch(`${baseUrl}/does-not-exist`);
      assert.equal(unknownPath.status, 404);

      const unknownGetPath = await fetch(`${baseUrl}/health/details`);
      assert.equal(unknownGetPath.status, 404);
    });

    assert.equal(stub.calls.length, 0);
  });
});
