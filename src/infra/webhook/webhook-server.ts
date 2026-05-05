import { timingSafeEqual } from "node:crypto";
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

export interface RateLimitAdminProvider {
  /** Whitelist of tool names that may be cleared. */
  registeredTools: readonly string[];
  /**
   * Removes the pause entry for `tool`. Returns the previous `pausedUntil`
   * (epoch ms) if one was cleared, or `undefined` if no pause existed.
   */
  clear(tool: string): Promise<number | undefined>;
  /**
   * Bearer token required in the `Authorization` header. When `undefined`
   * the route returns 503 — the operator has not enabled it.
   */
  adminToken?: string;
}

export interface WebhookServerOptions {
  handler: WebhookHandler;
  paths?: readonly string[];
  statusProvider?: StatusProvider;
  rateLimitAdmin?: RateLimitAdminProvider;
}

const DEFAULT_PATHS: readonly string[] = ["/webhook", "/github/webhooks"];
const ADMIN_RATE_LIMIT_CLEAR_PREFIX = "/admin/rate-limits/";
const ADMIN_RATE_LIMIT_CLEAR_SUFFIX = "/clear";

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
      req.method === "POST" &&
      req.url !== undefined &&
      req.url.startsWith(ADMIN_RATE_LIMIT_CLEAR_PREFIX) &&
      req.url.endsWith(ADMIN_RATE_LIMIT_CLEAR_SUFFIX)
    ) {
      await handleRateLimitClear(req, res, options.rateLimitAdmin);
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

async function handleRateLimitClear(
  req: IncomingMessage,
  res: ServerResponse,
  admin: RateLimitAdminProvider | undefined,
): Promise<void> {
  if (admin === undefined || admin.adminToken === undefined) {
    writeJson(res, 503, { status: "unavailable" });
    return;
  }

  if (!isAuthorizedAdmin(req, admin.adminToken)) {
    writeJson(res, 401, { status: "unauthorized" });
    return;
  }

  const url = req.url ?? "";
  const toolName = decodeURIComponent(
    url.slice(
      ADMIN_RATE_LIMIT_CLEAR_PREFIX.length,
      url.length - ADMIN_RATE_LIMIT_CLEAR_SUFFIX.length,
    ),
  );

  if (toolName.length === 0 || !admin.registeredTools.includes(toolName)) {
    writeJson(res, 404, { status: "unknown-tool", toolName });
    return;
  }

  let previous: number | undefined;
  try {
    previous = await admin.clear(toolName);
  } catch (error) {
    console.warn(
      `[webhook] /admin/rate-limits clear failed for tool=${toolName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    writeJson(res, 500, { status: "error" });
    return;
  }

  const previousIso =
    previous === undefined ? null : new Date(previous).toISOString();
  console.log(
    `[webhook] cleared rate-limit tool=${toolName} previousPausedUntil=${
      previousIso ?? "none"
    }`,
  );
  writeJson(res, 200, {
    toolName,
    cleared: previous !== undefined,
    pausedUntil: previousIso,
  });
}

function isAuthorizedAdmin(
  req: IncomingMessage,
  expectedToken: string,
): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  const provided = header.slice(prefix.length);
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}
