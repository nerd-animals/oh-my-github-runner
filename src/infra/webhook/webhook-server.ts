import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { WebhookHandler } from "../../services/webhook-handler.js";
import type { RunnerStatusSummary } from "../../services/runner-status-service.js";

export interface StatusProvider {
  getStatus(): Promise<RunnerStatusSummary>;
}

export interface WebhookServerOptions {
  handler: WebhookHandler;
  paths?: readonly string[];
  statusProvider?: StatusProvider;
}

const DEFAULT_PATHS: readonly string[] = ["/webhook", "/github/webhooks"];

export function createWebhookServer(options: WebhookServerOptions): Server {
  const allowedPaths = new Set(options.paths ?? DEFAULT_PATHS);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      if (options.statusProvider === undefined) {
        writeJson(res, 503, { status: "unavailable" });
        return;
      }

      try {
        const summary = await options.statusProvider.getStatus();
        writeJson(res, 200, summary);
      } catch (error) {
        console.warn(
          `[webhook] /status failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        writeJson(res, 503, { status: "unavailable" });
      }
      return;
    }

    if (
      req.method !== "POST" ||
      req.url === undefined ||
      !allowedPaths.has(req.url)
    ) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];

    try {
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }

    const body = Buffer.concat(chunks);

    try {
      const result = await options.handler.handle(body, req.headers);
      res.statusCode = result.status;
      res.end(result.body ?? "");
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
