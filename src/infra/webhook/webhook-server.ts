import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { WebhookHandler } from "../../services/webhook-handler.js";

export interface WebhookServerOptions {
  handler: WebhookHandler;
  path?: string;
}

const DEFAULT_PATH = "/webhook";

export function createWebhookServer(options: WebhookServerOptions): Server {
  const path = options.path ?? DEFAULT_PATH;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== path) {
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
