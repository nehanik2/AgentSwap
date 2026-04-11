/**
 * packages/server/src/routes/events.ts
 *
 * GET /events — Server-Sent Events stream.
 *
 * PROTOCOL
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Client connects.
 *   2. Server adds the connection to SSEManager and flushes SSE headers.
 *   3. Server immediately replays the current state of all known swaps
 *      (state_change event per swap) so late-joining clients get full context.
 *   4. From that point on, coordinator events are forwarded by SSEManager
 *      via broadcast() — the route itself does nothing more.
 *   5. On client disconnect, SSEManager removes the connection automatically
 *      via the 'close' listener registered in addClient().
 *
 * SSE EVENT NAMES
 * ─────────────────────────────────────────────────────────────────────────────
 *   state_change          — every SwapState transition
 *   btc_payment_request   — BOLT-11 invoice ready for buyer
 *   btc_locked            — BTC HODL invoice ACCEPTED
 *   deliverable_submitted — seller's work product preview
 *   swap_settled          — preimage revealed, both HTLCs settled
 *   swap_refunded         — swap cancelled, funds returning
 *   negotiation_message   — buyer/seller negotiation step
 *   error                 — unexpected coordinator error
 *   connected             — initial handshake + snapshot
 */

import { Router, type Request, type Response } from "express";
import type { SSEManager } from "../sseManager.js";
import type { SwapCoordinator } from "@agentswap/agents";

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface EventsRouterDeps {
  coordinator: SwapCoordinator;
  sseManager:  SSEManager;
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createEventsRouter(deps: EventsRouterDeps): Router {
  const { coordinator, sseManager } = deps;

  const router = Router();

  // ── GET / (mounted at /events) ──────────────────────────────────────────────

  /**
   * Establish an SSE stream with the dashboard.
   *
   * Optional query param:
   *   ?swapId=<uuid>  — filter future events to a single swap (NOT YET filtered
   *                     in SSEManager.broadcast, but included in the handshake)
   */
  router.get(
    "/",
    (req: Request, res: Response): void => {
      // 1. Register client — sets headers, flushes, registers disconnect cleanup.
      sseManager.addClient(res);

      const filterSwapId = typeof req.query.swapId === "string"
        ? req.query.swapId
        : undefined;

      // 2. Send connected handshake so the client knows the stream is live.
      sseManager.sendToClient(res, "connected", {
        message:      "Connected to AgentSwap event stream",
        timestamp:    new Date().toISOString(),
        clientCount:  sseManager.getClientCount(),
        filterSwapId: filterSwapId ?? null,
      });

      // 3. Replay current state of all known swaps so late joiners catch up.
      const allSwaps = coordinator.getAllSwaps();
      for (const swap of allSwaps) {
        // Skip if client filtered to a different swap
        if (filterSwapId && swap.id !== filterSwapId) continue;

        sseManager.sendToClient(res, "state_change", {
          swapId:    swap.id,
          newState:  swap.state,
          record:    swap,
          timestamp: new Date().toISOString(),
        });
      }
      // No further action needed — coordinator events reach this client via
      // sseManager.broadcast() which is wired in index.ts.
    }
  );

  return router;
}
