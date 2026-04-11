/**
 * In-memory swap store with a simple pub/sub mechanism.
 *
 * In production you'd replace this with Redis pub/sub or a database.
 * For the hackathon a singleton Map is sufficient — Node.js is single-threaded
 * so there are no race conditions within a single process.
 */

import { SwapState } from "@agentswap/shared";
import type { SwapRecord, AgentMessage } from "@agentswap/shared";

type SubscriberFn = (event: string, payload: unknown) => void;

interface StoreEntry {
  record: SwapRecord;
  subscribers: Set<SubscriberFn>;
  error?: string;
}

class SwapStore {
  private readonly entries = new Map<string, StoreEntry>();

  init(swapId: string): void {
    if (this.entries.has(swapId)) return;
    this.entries.set(swapId, {
      record: {
        proposal: {} as SwapRecord["proposal"], // will be populated by first message
        state: SwapState.NEGOTIATING,
        messages: [],
      },
      subscribers: new Set(),
    });
  }

  has(swapId: string): boolean {
    return this.entries.has(swapId);
  }

  get(swapId: string): SwapRecord | undefined {
    return this.entries.get(swapId)?.record;
  }

  addMessage(swapId: string, msg: AgentMessage): void {
    const entry = this.entries.get(swapId);
    if (!entry) return;
    entry.record.messages.push(msg);
    // Patch proposal.id if not yet set
    if (!entry.record.proposal.id && msg.swapId) {
      entry.record.proposal = { ...entry.record.proposal, id: msg.swapId };
    }
    this._notify(swapId, "message", msg);
  }

  setState(swapId: string, state: SwapState): void {
    const entry = this.entries.get(swapId);
    if (!entry) return;
    entry.record.state = state;
    this._notify(swapId, "stateChange", { swapId, state });
  }

  setComplete(swapId: string, record: SwapRecord): void {
    const entry = this.entries.get(swapId);
    if (!entry) return;
    entry.record = record;
    this._notify(swapId, "complete", record);
  }

  setError(swapId: string, message: string): void {
    const entry = this.entries.get(swapId);
    if (!entry) return;
    entry.error = message;
    this._notify(swapId, "error", { swapId, message });
  }

  /** Manually trigger re-broadcast — kept for API compatibility with route handlers. */
  notifySubscribers(_swapId: string): void {
    // Individual addMessage/setState already notify inline.
    // The leading underscore tells TS this parameter is intentionally unused.
  }

  subscribe(swapId: string, fn: SubscriberFn): () => void {
    const entry = this.entries.get(swapId);
    if (!entry) return () => {};
    entry.subscribers.add(fn);
    return () => entry.subscribers.delete(fn);
  }

  private _notify(swapId: string, event: string, payload: unknown): void {
    const entry = this.entries.get(swapId);
    if (!entry) return;
    for (const fn of entry.subscribers) {
      try { fn(event, payload); } catch { /* subscriber errors must not crash the store */ }
    }
  }
}

// Singleton — shared across all API route invocations in the same process
export const swapStore = new SwapStore();
