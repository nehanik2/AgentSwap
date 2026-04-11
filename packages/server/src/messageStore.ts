/**
 * packages/server/src/messageStore.ts
 *
 * In-memory per-swap AgentMessage log for the server.
 *
 * WHY this exists
 * ─────────────────────────────────────────────────────────────────────────────
 *   SwapCoordinator tracks on-chain state (locks, hashes, receipts) but does
 *   not store a human-readable conversation thread.  The server builds that
 *   thread here by synthesising AgentMessage objects from coordinator events
 *   (BTC locked, deliverable submitted, settled, …) plus negotiation status
 *   messages emitted by the swap route.
 *
 *   The resulting history is returned by GET /swap/:swapId/messages and is
 *   also used to replay the feed on SSE reconnect.
 *
 * THREAD STRUCTURE (chronological)
 * ─────────────────────────────────────────────────────────────────────────────
 *   role:buyer       — "Negotiation started for task: …"
 *   role:seller      — "Negotiation agreed: N sats / M wei"  (or "failed")
 *   role:buyer       — "Lightning invoice ready: lnbc…"
 *   role:buyer       — "BTC locked in Lightning HTLC"
 *   role:seller      — <deliverable preview, first 500 chars>
 *   role:arbitrator  — "APPROVED / REJECTED — reasoning"
 */

import type { AgentMessage } from "@agentswap/shared";

// ── MessageStore ──────────────────────────────────────────────────────────────

export class MessageStore {
  private readonly store = new Map<string, AgentMessage[]>();

  // ── init ───────────────────────────────────────────────────────────────────

  /**
   * Initialise an empty message list for a swap.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  init(swapId: string): void {
    if (!this.store.has(swapId)) {
      this.store.set(swapId, []);
    }
  }

  // ── add ────────────────────────────────────────────────────────────────────

  /**
   * Append a message to the history for a swap.
   * Automatically initialises the list if it doesn't exist yet.
   */
  add(swapId: string, msg: AgentMessage): void {
    if (!this.store.has(swapId)) this.init(swapId);
    this.store.get(swapId)!.push(msg);
  }

  // ── get ────────────────────────────────────────────────────────────────────

  /**
   * Return a shallow copy of the message history for a swap.
   * Returns an empty array if the swap is unknown.
   */
  get(swapId: string): AgentMessage[] {
    return [...(this.store.get(swapId) ?? [])];
  }

  // ── has ────────────────────────────────────────────────────────────────────

  /** True if any messages have been stored for this swap. */
  has(swapId: string): boolean {
    return this.store.has(swapId);
  }

  // ── allSwapIds ─────────────────────────────────────────────────────────────

  /** All swap IDs that have at least one message, in insertion order. */
  allSwapIds(): string[] {
    return Array.from(this.store.keys());
  }
}
