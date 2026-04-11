/**
 * packages/agents/src/messageBus.ts
 *
 * Async message bus for agent-to-agent communication.
 *
 * Features:
 *   - 500 ms simulated delivery delay (realistic feel for demo)
 *   - Structured console logging (timestamp, sender, type, amounts)
 *   - Full conversation history, retrievable by swapId
 *   - Type-safe EventEmitter subscriptions
 */

import { EventEmitter } from "events";
import type { NegotiationMessage } from "./negotiationSchema.js";

// ── Message type ──────────────────────────────────────────────────────────────

export interface BusMessage {
  /** Which agent sent this message. */
  from: "buyer" | "seller";
  /** Swap this message belongs to. */
  swapId: string;
  /** The structured negotiation payload. */
  negotiation: NegotiationMessage;
  /** ISO 8601 send timestamp (set by the bus, not the sender). */
  timestamp: string;
}

// ── Event map ─────────────────────────────────────────────────────────────────

interface MessageBusEvents {
  /** Fires for every delivered message regardless of swapId. */
  message: (msg: BusMessage) => void;
  /** Fires for errors in async delivery handlers. */
  error: (err: Error) => void;
}

export declare interface MessageBus {
  on<K extends keyof MessageBusEvents>(event: K, listener: MessageBusEvents[K]): this;
  once<K extends keyof MessageBusEvents>(event: K, listener: MessageBusEvents[K]): this;
  off<K extends keyof MessageBusEvents>(event: K, listener: MessageBusEvents[K]): this;
  emit<K extends keyof MessageBusEvents>(event: K, ...args: Parameters<MessageBusEvents[K]>): boolean;
}

// ── Bus implementation ───────────────────────────────────────────────��────────

const DELIVERY_DELAY_MS = 500;

export class MessageBus extends EventEmitter {
  private readonly history = new Map<string, BusMessage[]>();

  /**
   * Send a negotiation message.
   *
   * The message is stored in history immediately, logged to console,
   * then delivered to subscribers after a 500 ms simulated delay.
   */
  async send(params: {
    from: "buyer" | "seller";
    swapId: string;
    negotiation: NegotiationMessage;
  }): Promise<void> {
    const message: BusMessage = {
      from: params.from,
      swapId: params.swapId,
      negotiation: params.negotiation,
      timestamp: new Date().toISOString(),
    };

    // Store in history before delivery so observers see it immediately
    const bucket = this.history.get(params.swapId) ?? [];
    bucket.push(message);
    this.history.set(params.swapId, bucket);

    // Structured log
    this._log(message);

    // Simulate network / processing delay
    await sleep(DELIVERY_DELAY_MS);

    // Deliver to all subscribers
    this.emit("message", message);
    // Also emit a swap-specific event for targeted listeners
    this.emit(`swap:${params.swapId}` as "message", message);
  }

  /**
   * Subscribe to ALL messages on this bus.
   * @returns Unsubscribe function — call it to remove the listener.
   */
  subscribe(handler: (msg: BusMessage) => void): () => void {
    this.on("message", handler);
    return () => this.off("message", handler);
  }

  /**
   * Subscribe to messages for a specific swap only.
   * @returns Unsubscribe function.
   */
  subscribeToSwap(swapId: string, handler: (msg: BusMessage) => void): () => void {
    const event = `swap:${swapId}` as "message";
    this.on(event, handler);
    return () => this.off(event, handler);
  }

  // ── History ─────────────────────────────────────────────────────────────────

  /** Returns a shallow copy of the message history for a swap. */
  getHistory(swapId: string): BusMessage[] {
    return [...(this.history.get(swapId) ?? [])];
  }

  /** Returns the total number of messages logged for a swap. */
  getMessageCount(swapId: string): number {
    return this.history.get(swapId)?.length ?? 0;
  }

  /** Returns all swap IDs that have at least one message. */
  getActiveSwapIds(): string[] {
    return Array.from(this.history.keys());
  }

  /** Remove history for a completed/abandoned swap. */
  clearHistory(swapId: string): void {
    this.history.delete(swapId);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _log(msg: BusMessage): void {
    const shortId = msg.swapId.slice(0, 8);
    const n = msg.negotiation;
    const ethEther = (BigInt(n.ethAmountWei) * 100n / BigInt(1e18)).toString();
    const ethDisplay = `${(Number(ethEther) / 100).toFixed(4)} ETH`;

    console.log(
      `${msg.timestamp} [MessageBus] [${shortId}…] ` +
      `${msg.from.padEnd(6)} → ${n.messageType.padEnd(7)} ` +
      `r${n.round} | ` +
      `BTC ${n.btcAmountSats.toLocaleString()} sats | ` +
      `ETH ${ethDisplay} | ` +
      `"${n.reasoning.slice(0, 60)}${n.reasoning.length > 60 ? "…" : ""}"`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
