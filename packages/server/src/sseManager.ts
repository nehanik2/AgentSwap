/**
 * packages/server/src/sseManager.ts
 *
 * Manages the pool of live SSE client connections.
 *
 * DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 *   Each connected browser tab gets its own express.Response object in the
 *   pool. broadcast() serialises the event payload and writes the SSE frame
 *   to every client simultaneously. Clients are removed on disconnect so the
 *   pool never leaks.
 *
 * SSE FRAME FORMAT
 * ─────────────────────────────────────────────────────────────────────────────
 *   event: <eventType>\n
 *   data: <JSON payload>\n
 *   \n
 *
 * BigInt fields are serialised to strings so JSON.stringify doesn't throw.
 */

import type { Response } from "express";

// ── SSEManager ────────────────────────────────────────────────────────────────

export class SSEManager {
  private readonly clients = new Set<Response>();

  // ── addClient ──────────────────────────────────────────────────────────────

  /**
   * Register a new SSE client.
   *
   * Writes the required SSE headers and schedules automatic cleanup when the
   * underlying socket closes.
   *
   * @param res  Express response that will carry the event stream.
   */
  addClient(res: Response): void {
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    this.clients.add(res);

    res.on("close", () => this.removeClient(res));

    this._log(`Client connected. Pool size: ${this.clients.size}`);
  }

  // ── removeClient ───────────────────────────────────────────────────────────

  /**
   * Remove a client from the pool.
   * Safe to call multiple times for the same client.
   */
  removeClient(res: Response): void {
    if (this.clients.delete(res)) {
      this._log(`Client disconnected. Pool size: ${this.clients.size}`);
    }
  }

  // ── broadcast ──────────────────────────────────────────────────────────────

  /**
   * Send an SSE event to every connected client.
   *
   * @param eventType  SSE event name (e.g. "state_change", "swap_settled").
   *                   Underscores preferred over colons so browsers parse the
   *                   `event:` field cleanly.
   * @param data       JSON-serialisable payload. BigInt values become strings.
   */
  broadcast(eventType: string, data: unknown): void {
    if (this.clients.size === 0) return;

    const frame = formatSSEFrame(eventType, data);
    const dead: Response[] = [];

    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        // Socket already closed — collect for removal
        dead.push(client);
      }
    }

    for (const client of dead) this.removeClient(client);
  }

  // ── sendToClient ───────────────────────────────────────────────────────────

  /**
   * Send an SSE event to a single specific client.
   * Used to replay historical state on initial connection without broadcasting.
   *
   * @param res        The target client response.
   * @param eventType  SSE event name.
   * @param data       JSON-serialisable payload.
   */
  sendToClient(res: Response, eventType: string, data: unknown): void {
    try {
      res.write(formatSSEFrame(eventType, data));
    } catch {
      this.removeClient(res);
    }
  }

  // ── keepAlive ──────────────────────────────────────────────────────────────

  /**
   * Send a no-op SSE comment to all clients.
   * Should be called every 15–30s to prevent proxy / load-balancer timeouts.
   *
   * @param intervalMs  Ping interval in milliseconds (default 20 000 ms).
   * @returns NodeJS.Timer — call clearInterval() on it to stop pinging.
   */
  startKeepAlive(intervalMs = 20_000): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (this.clients.size === 0) return;
      const ping = ": ping\n\n";
      const dead: Response[] = [];
      for (const client of this.clients) {
        try { client.write(ping); }
        catch { dead.push(client); }
      }
      for (const client of dead) this.removeClient(client);
    }, intervalMs);
  }

  // ── getClientCount ─────────────────────────────────────────────────────────

  /** Number of currently connected SSE clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _log(message: string): void {
    console.log(`${new Date().toISOString()} [SSEManager] ${message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Serialise an event+data pair into a valid SSE frame string.
 * BigInt values are converted to strings so JSON.stringify never throws.
 */
function formatSSEFrame(eventType: string, data: unknown): string {
  const json = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  return `event: ${eventType}\ndata: ${json}\n\n`;
}
