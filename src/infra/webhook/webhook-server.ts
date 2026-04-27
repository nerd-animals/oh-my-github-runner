import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { WebhookHandler } from "../../services/webhook-handler.js";

export interface WebhookServerOptions {
  handler: WebhookHandler;
  paths?: readonly string[];
}

const DEFAULT_PATHS: readonly string[] = ["/webhook", "/github/webhooks"];

export function createWebhookServer(options: WebhookServerOptions): Server {
  const allowedPaths = new Set(options.paths ?? DEFAULT_PATHS);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
