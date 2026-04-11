/**
 * packages/agents/src/events.ts
 *
 * Typed event definitions for SwapCoordinator.
 *
 * Usage pattern (declaration merging — no extra library needed):
 *
 *   import type { CoordinatorEventMap } from "./events.js";
 *   declare interface SwapCoordinator {
 *     on<K extends keyof CoordinatorEventMap>(event: K, listener: CoordinatorEventMap[K]): this;
 *     emit<K extends keyof CoordinatorEventMap>(event: K, ...args: Parameters<CoordinatorEventMap[K]>): boolean;
 *   }
 *
 * The dashboard's SSE handler subscribes to these events and forwards them
 * to connected clients as JSON-serialized server-sent events.
 *
 * ⚠️  None of these event payloads must include the raw preimage Buffer —
 *     only the hex string is safe to emit externally.
 */

import type { SwapState } from "@agentswap/shared";
import type { PublicSwapRecord } from "./types.js";

// ── Individual payload types ─────────────────────────────────────────────────

/** Payload for the 'state:change' event. */
export interface StateChangeEvent {
  swapId: string;
  newState: SwapState;
  /** Sanitised snapshot of the record at the time of the transition. */
  record: PublicSwapRecord;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Payload for 'btc:locked' — BTC HODL invoice has reached ACCEPTED state. */
export interface BtcLockedEvent {
  swapId: string;
  /** Payment hash (hex) of the confirmed HODL invoice. */
  rHash: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Payload for 'btc:payment_request' — BOLT-11 string ready for the buyer. */
export interface BtcPaymentRequestEvent {
  swapId: string;
  /** BOLT-11 invoice the buyer must pay to lock BTC. */
  paymentRequest: string;
  /** Expiry time of the invoice. */
  expiryAt: string; // ISO 8601
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Payload for 'deliverable:submitted'. */
export interface DeliverableSubmittedEvent {
  swapId: string;
  /** The seller's work product, truncated to 500 chars for the event payload. */
  deliverablePreview: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Payload for 'swap:settled' — both chains have been settled. */
export interface SwapSettledEvent {
  swapId: string;
  /**
   * The preimage, hex-encoded.
   * Now public on the Lightning network — seller can use it to claim ETH.
   */
  preimageHex: string;
  /** BTC txid / payment hash. */
  btcTxId?: string;
  /** ETH claim tx hash (if the coordinator performed the claim). */
  ethTxId?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Payload for 'swap:refunded' — swap was cancelled and funds returned. */
export interface SwapRefundedEvent {
  swapId: string;
  reason: string;
  /**
   * ETH refund tx hash. May be absent if the ETH timelock has not yet expired
   * — callers should retry htlcClient.refund(ethLockId) after the expiry time.
   */
  ethRefundTxHash?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Payload for the 'error' event. */
export interface CoordinatorErrorEvent {
  swapId: string;
  message: string;
  /** Current state at the time of the error. */
  state?: SwapState;
  /** ISO 8601 timestamp */
  timestamp: string;
}

// ── Event map ────────────────────────────────────────────────────────────────

/**
 * Complete typed event map for SwapCoordinator.
 *
 * Keys are event names; values are the corresponding listener signatures.
 * Used with TypeScript declaration merging to add compile-time safety to
 * EventEmitter calls without introducing a third-party library.
 */
export interface CoordinatorEventMap {
  /**
   * Emitted on every state machine transition.
   * The dashboard's SSE handler forwards this to connected clients.
   */
  "state:change": (event: StateChangeEvent) => void;

  /**
   * Emitted once the BTC HODL invoice has been created and the buyer can pay.
   * The coordinator exposes the paymentRequest here so it can be shown in the UI.
   */
  "btc:payment_request": (event: BtcPaymentRequestEvent) => void;

  /**
   * Emitted when the buyer's Lightning payment reaches ACCEPTED state —
   * i.e., BTC funds are now locked in escrow on the Lightning network.
   */
  "btc:locked": (event: BtcLockedEvent) => void;

  /**
   * Emitted when the seller submits their work product.
   * Triggers the arbitrator evaluation flow.
   */
  "deliverable:submitted": (event: DeliverableSubmittedEvent) => void;

  /**
   * Emitted when both chains have been settled (happy path).
   * The preimage is now public on the Lightning network.
   */
  "swap:settled": (event: SwapSettledEvent) => void;

  /**
   * Emitted when the swap is cancelled (arbitrator rejection or timelock expiry).
   */
  "swap:refunded": (event: SwapRefundedEvent) => void;

  /** Emitted on any unexpected error during the lifecycle. */
  "error": (event: CoordinatorErrorEvent) => void;
}
