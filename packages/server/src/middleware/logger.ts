/**
 * packages/server/src/middleware/logger.ts
 *
 * Minimal request/response logger.
 *
 * Output format (one line per request):
 *   2026-04-11T12:00:00.123Z  POST  /swap/start         → 200  (47ms)
 *   2026-04-11T12:00:00.456Z  GET   /events              → 200  (SSE)
 */

import type { Request, Response, NextFunction } from "express";

// ── requestLogger ─────────────────────────────────────────────────────────────

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();
  const ts    = new Date().toISOString();

  // Use the 'finish' event rather than hooking res.end so SSE streams
  // (which never finish) don't block the log line from appearing at all.
  res.once("finish", () => {
    const duration = Date.now() - start;
    const method   = req.method.padEnd(6);
    const path     = (req.originalUrl || req.url).padEnd(30);
    const status   = res.statusCode;
    const label    = res.getHeader("content-type")
      ?.toString()
      .includes("text/event-stream")
        ? "(SSE)"
        : `(${duration}ms)`;

    console.log(
      `${ts}  ${method}  ${path}  → ${status}  ${label}`
    );
  });

  // For SSE connections that never emit 'finish', log the open on 'close'.
  res.once("close", () => {
    const ct = res.getHeader("content-type")?.toString() ?? "";
    if (ct.includes("text/event-stream")) {
      const duration = Date.now() - start;
      console.log(
        `${ts}  ${req.method.padEnd(6)}  ${(req.originalUrl || req.url).padEnd(30)}` +
        `  → closed  (SSE held ${duration}ms)`
      );
    }
  });

  next();
}
