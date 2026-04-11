"use client";

/**
 * packages/dashboard/hooks/useSSE.ts
 *
 * Connects to the AgentSwap Express server's GET /events SSE stream,
 * parses every event into a typed DashboardSwapState and returns it to
 * the component tree.
 *
 * RECONNECTION: exponential backoff starting at 1 s, capped at 30 s.
 * DEDUPLICATION: messages are keyed on timestamp+content to prevent
 *   duplicate entries on reconnect replays.
 */

import { useState, useEffect, useRef } from "react";
import type { AgentMessage } from "@agentswap/shared";

// ── Server URL (set NEXT_PUBLIC_SERVER_URL in .env.local) ─────────────────────

export const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";

// ── Public types ──────────────────────────────────────────────────────────────

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface CriterionScore {
  score:    number;
  feedback: string;
}

export interface CriteriaScores {
  completeness: CriterionScore;
  quality:      CriterionScore;
  accuracy:     CriterionScore;
  onTime:       CriterionScore;
}

/** All dashboard state derived from SSE events for a single swap. */
export interface DashboardSwapState {
  swapId: string;

  /** Current SwapState string from the coordinator. */
  state: string;

  /** Full message thread: negotiation + coordinator event summaries. */
  messages: AgentMessage[];

  // ── Proposal ───────────────────────────────────────────────────────────────
  taskDescription?: string;
  /** BTC amount in satoshis, as a numeric string (serialised bigint). */
  btcAmountSats?: string;
  /** ETH amount in wei, as a numeric string (serialised bigint). */
  ethAmountWei?:  string;

  // ── HTLC state ─────────────────────────────────────────────────────────────
  btcRHash?:          string;
  btcPaymentRequest?: string;
  /** Unix seconds — BTC timelock expiry. */
  btcLockTime?:       number;
  /** Amount string from BTCReceipt.amount (sats). */
  btcAmountLocked?:   string;

  ethLockId?:       string;
  /** Unix seconds — ETH timelock expiry. */
  ethLockTime?:     number;
  /** Amount string from ETHReceipt.amount (wei). */
  ethAmountLocked?: string;

  // ── Settlement / refund ────────────────────────────────────────────────────
  settled:      boolean;
  refunded:     boolean;
  preimageHex?: string;
  refundReason?: string;
  /** Bitcoin transaction / payment ID from the settlement event */
  btcTxId?: string;
  /** Ethereum transaction hash from the settlement event */
  ethTxId?: string;
  /** Unix ms timestamp when the swap reached SETTLED state */
  settledAt?: number;
  /** Unix ms timestamp when this swap record was first created */
  startedAt: number;

  // ── Arbitrator ─────────────────────────────────────────────────────────────
  arbitratorApproved?:  boolean;
  arbitratorScore?:     number;
  arbitratorReasoning?: string;
  criteriaScores?:      CriteriaScores;
}

export interface LatestEvent {
  type: string;
  data: unknown;
}

export interface UseSSEResult {
  swaps:            Map<string, DashboardSwapState>;
  latestEvent:      LatestEvent | null;
  connectionStatus: ConnectionStatus;
}

// ── Internal types (SSE event shapes from the server) ────────────────────────

interface StateChangePayload {
  swapId:   string;
  newState: string;
  record: {
    id:                 string;
    proposal?:          { taskDescription?: string; btcAmountSats?: string; ethAmountWei?: string };
    ethLockId?:         string;
    btcRHash?:          string;
    btcPaymentRequest?: string;
    ethReceipt?:        { amount: string; lockTime: number };
    btcReceipt?:        { amount: string; lockTime: number };
    arbitratorReasoning?: string;
    qualityScore?:      number;
    criteriaScores?:    CriteriaScores;
  };
  timestamp: string;
}

interface BtcPaymentRequestPayload {
  swapId:         string;
  paymentRequest: string;
  expiryAt:       string;
  timestamp:      string;
}

interface BtcLockedPayload { swapId: string; rHash: string; timestamp: string; }

interface DeliverableSubmittedPayload {
  swapId:           string;
  deliverablePreview: string;
  timestamp:        string;
}

interface SwapSettledPayload {
  swapId:      string;
  preimageHex: string;
  btcTxId?:    string;
  ethTxId?:    string;
  timestamp:   string;
}

interface SwapRefundedPayload {
  swapId:           string;
  reason:           string;
  ethRefundTxHash?: string;
  timestamp:        string;
}

interface ErrorPayload { swapId: string; message: string; timestamp: string; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptySwap(swapId: string): DashboardSwapState {
  return {
    swapId,
    state:      "NEGOTIATING",
    messages:   [],
    settled:    false,
    refunded:   false,
    startedAt:  Date.now(),
  };
}

function addMessageDeduped(
  messages: AgentMessage[],
  msg: AgentMessage
): AgentMessage[] {
  // Key: swapId + timestamp + first 60 chars of content
  const key = `${msg.swapId}|${msg.timestamp}|${msg.content.slice(0, 60)}`;
  if (messages.some(m => `${m.swapId}|${m.timestamp}|${m.content.slice(0, 60)}` === key)) {
    return messages;
  }
  return [...messages, msg];
}

function applyEvent(
  swap: DashboardSwapState,
  type: string,
  raw: unknown
): DashboardSwapState {
  switch (type) {
    // ── state:change ─────────────────────────────────────────────────────────
    case "state_change": {
      const e = raw as StateChangePayload;
      const r = e.record;
      return {
        ...swap,
        state:              e.newState,
        taskDescription:    r.proposal?.taskDescription ?? swap.taskDescription,
        btcAmountSats:      r.proposal?.btcAmountSats   ?? swap.btcAmountSats,
        ethAmountWei:       r.proposal?.ethAmountWei    ?? swap.ethAmountWei,
        ethLockId:          r.ethLockId                 ?? swap.ethLockId,
        btcRHash:           r.btcRHash                  ?? swap.btcRHash,
        btcPaymentRequest:  r.btcPaymentRequest         ?? swap.btcPaymentRequest,
        btcLockTime:        r.btcReceipt?.lockTime      ?? swap.btcLockTime,
        btcAmountLocked:    r.btcReceipt?.amount        ?? swap.btcAmountLocked,
        ethLockTime:        r.ethReceipt?.lockTime      ?? swap.ethLockTime,
        ethAmountLocked:    r.ethReceipt?.amount        ?? swap.ethAmountLocked,
        arbitratorReasoning:r.arbitratorReasoning       ?? swap.arbitratorReasoning,
        arbitratorScore:    r.qualityScore              ?? swap.arbitratorScore,
        criteriaScores:     r.criteriaScores            ?? swap.criteriaScores,
        arbitratorApproved: e.newState === "SETTLED"    ? true
                          : e.newState === "REFUNDED"   ? false
                          : swap.arbitratorApproved,
        settled:  e.newState === "SETTLED" || swap.settled,
        refunded: e.newState === "REFUNDED" || swap.refunded,
      };
    }

    // ── negotiation message ───────────────────────────────────────────────────
    case "negotiation_message": {
      const msg = raw as AgentMessage;
      return { ...swap, messages: addMessageDeduped(swap.messages, msg) };
    }

    // ── BTC payment request ready ─────────────────────────────────────────────
    case "btc_payment_request": {
      const e = raw as BtcPaymentRequestPayload;
      const msg: AgentMessage = {
        role:      "buyer",
        content:   `⚡ Lightning invoice ready — pay to lock BTC:\n${e.paymentRequest.slice(0, 80)}…`,
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      return {
        ...swap,
        btcPaymentRequest: e.paymentRequest,
        messages: addMessageDeduped(swap.messages, msg),
      };
    }

    // ── BTC locked ────────────────────────────────────────────────────────────
    case "btc_locked": {
      const e = raw as BtcLockedPayload;
      const msg: AgentMessage = {
        role:      "buyer",
        content:   `🔐 BTC locked in Lightning HTLC. rHash: ${e.rHash.slice(0, 16)}… Awaiting deliverable.`,
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      return {
        ...swap,
        btcRHash: e.rHash,
        messages: addMessageDeduped(swap.messages, msg),
      };
    }

    // ── Deliverable submitted ─────────────────────────────────────────────────
    case "deliverable_submitted": {
      const e = raw as DeliverableSubmittedPayload;
      const msg: AgentMessage = {
        role:      "seller",
        content:   e.deliverablePreview,
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      const arbitratorMsg: AgentMessage = {
        role:      "arbitrator",
        content:   "⚖️ Deliverable received. Evaluating against the original specification…",
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      return {
        ...swap,
        messages: addMessageDeduped(
          addMessageDeduped(swap.messages, msg),
          arbitratorMsg
        ),
      };
    }

    // ── Swap settled (the wow moment) ─────────────────────────────────────────
    case "swap_settled": {
      const e = raw as SwapSettledPayload;
      const msg: AgentMessage = {
        role:      "arbitrator",
        content:
          `✅ APPROVED — Atomic swap settled on both chains.\n` +
          `Preimage: 0x${e.preimageHex.slice(0, 16)}…\n` +
          `Seller can now claim ETH using this preimage.`,
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      return {
        ...swap,
        state:              "SETTLED",
        settled:            true,
        preimageHex:        e.preimageHex,
        btcTxId:            e.btcTxId   ?? swap.btcTxId,
        ethTxId:            e.ethTxId   ?? swap.ethTxId,
        settledAt:          Date.now(),
        arbitratorApproved: true,
        messages:           addMessageDeduped(swap.messages, msg),
      };
    }

    // ── Swap refunded ─────────────────────────────────────────────────────────
    case "swap_refunded": {
      const e = raw as SwapRefundedPayload;
      const msg: AgentMessage = {
        role:      "arbitrator",
        content:   `❌ Funds refunded. ${e.reason}`,
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      return {
        ...swap,
        state:              "REFUNDED",
        refunded:           true,
        refundReason:       e.reason,
        arbitratorApproved: false,
        messages:           addMessageDeduped(swap.messages, msg),
      };
    }

    // ── Error ─────────────────────────────────────────────────────────────────
    case "error": {
      const e = raw as ErrorPayload;
      const msg: AgentMessage = {
        role:      "arbitrator",
        content:   `⚠️ Error: ${e.message}`,
        timestamp: e.timestamp,
        swapId:    e.swapId,
      };
      return { ...swap, messages: addMessageDeduped(swap.messages, msg) };
    }

    default:
      return swap;
  }
}

// ── useSSE ─────────────────────────────────────────────────────────────────────

/**
 * @param swapId  Optional filter — if provided, the SSE connection sends
 *                ?swapId=… to the server and the hook highlights that swap.
 */
export function useSSE(swapId?: string): UseSSEResult {
  const [swaps, setSwaps] = useState<Map<string, DashboardSwapState>>(new Map());
  const [latestEvent, setLatestEvent] = useState<LatestEvent | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

  // Keep mutable refs inside the effect so we don't need them in deps
  const backoffRef  = useRef(1000);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef       = useRef<EventSource | null>(null);
  const mountedRef  = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const ALL_EVENTS = [
      "connected",
      "state_change",
      "btc_payment_request",
      "btc_locked",
      "deliverable_submitted",
      "swap_settled",
      "swap_refunded",
      "negotiation_message",
      "error",
    ] as const;

    function connect(): void {
      if (!mountedRef.current) return;

      const qs   = swapId ? `?swapId=${encodeURIComponent(swapId)}` : "";
      const url  = `${SERVER_URL}/events${qs}`;
      const es   = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (!mountedRef.current) return;
        setConnectionStatus("connected");
        backoffRef.current = 1000; // reset on success
      };

      es.onerror = () => {
        if (!mountedRef.current) return;
        es.close();
        setConnectionStatus("disconnected");
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
        timerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setConnectionStatus("connecting");
          connect();
        }, delay);
      };

      for (const eventType of ALL_EVENTS) {
        es.addEventListener(eventType, (ev: Event) => {
          if (!mountedRef.current) return;
          const me = ev as MessageEvent;
          try {
            const data = JSON.parse(me.data as string) as unknown;

            setLatestEvent({ type: eventType, data });

            // Extract swapId from payload
            const payloadSwapId =
              data !== null &&
              typeof data === "object" &&
              "swapId" in data
                ? (data as { swapId: string }).swapId
                : null;

            if (payloadSwapId) {
              setSwaps((prev) => {
                const next = new Map(prev);
                const existing = next.get(payloadSwapId) ?? emptySwap(payloadSwapId);
                next.set(payloadSwapId, applyEvent(existing, eventType, data));
                return next;
              });
            }
          } catch {
            // Malformed JSON — ignore
          }
        });
      }
    }

    setConnectionStatus("connecting");
    connect();

    return () => {
      mountedRef.current = false;
      esRef.current?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // swapId intentionally in deps — reconnect when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapId]);

  return { swaps, latestEvent, connectionStatus };
}
