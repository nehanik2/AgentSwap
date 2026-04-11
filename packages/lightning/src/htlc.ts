/**
 * High-level Lightning HTLC helpers used by the agent layer.
 *
 * The atomic swap protocol (simplified):
 *   1. Buyer generates a random preimage and computes hash = SHA256(preimage).
 *   2. Seller creates a HOLD invoice on their LND node, locked to `hash`.
 *   3. Buyer pays the invoice — funds are in-flight (HTLC locked).
 *   4. Arbitrator approves → buyer reveals preimage → seller settles invoice.
 *   5. On timeout → seller cancels invoice → buyer's funds are returned.
 */

import crypto from "crypto";
import type { LndClient } from "./client.js";
import type { HTLCReceipt, PreimageHash, Preimage } from "@agentswap/shared";

// ── Preimage helpers ─────────────────────────────────────────────────────────

/** Generate a cryptographically random 32-byte preimage (hex) */
export function generatePreimage(): Preimage {
  return crypto.randomBytes(32).toString("hex");
}

/** SHA-256 hash of a preimage (hex → hex) */
export function hashPreimage(preimageHex: Preimage): PreimageHash {
  return crypto.createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
}

// ── Lock ─────────────────────────────────────────────────────────────────────

/**
 * Create a hold invoice on the SELLER's node.
 * The invoice is locked to the buyer's preimage hash so only the buyer can
 * unlock it by revealing the preimage.
 *
 * Returns the HTLCReceipt that gets stored in SwapRecord.btcReceipt.
 */
export async function lockBtcHTLC(params: {
  sellerLnd: LndClient;
  preimageHash: PreimageHash;
  amountSats: number;
  /** Hours until the HTLC should expire */
  timelockHours: number;
}): Promise<{ receipt: HTLCReceipt; invoice: string }> {
  const expirySecs = params.timelockHours * 3600;

  const { payment_request } = await params.sellerLnd.createHoldInvoice({
    hash: params.preimageHash,
    valueSat: params.amountSats,
    expiry: expirySecs,
    memo: `AgentSwap HTLC — hash ${params.preimageHash.slice(0, 8)}…`,
  });

  const lockTime = Math.floor(Date.now() / 1000) + expirySecs;

  const receipt: HTLCReceipt = {
    chain: "btc",
    txId: params.preimageHash, // pre-payment we identify by hash; updated post-pay
    lockTime,
    amount: params.amountSats.toString(),
    preimageHash: params.preimageHash,
    invoice: payment_request,
  };

  return { receipt, invoice: payment_request };
}

// ── Pay ──────────────────────────────────────────────────────────────────────

/**
 * Buyer pays the hold invoice — funds become locked in-flight.
 * Returns the payment hash which can be used to track the HTLC.
 */
export async function payBtcHTLC(params: {
  buyerLnd: LndClient;
  invoice: string;
  feeLimitSat?: number;
}): Promise<{ paymentHash: string }> {
  const result = await params.buyerLnd.payInvoice({
    paymentRequest: params.invoice,
    timeoutSeconds: 120,
    feeLimitSat: params.feeLimitSat ?? 500,
  });

  if (result.status !== "SUCCEEDED") {
    throw new Error(`Lightning payment failed with status: ${result.status}`);
  }

  return { paymentHash: result.payment_hash };
}

// ── Settle ───────────────────────────────────────────────────────────────────

/**
 * Seller settles the hold invoice by revealing the preimage.
 * This atomically transfers funds from buyer to seller.
 */
export async function settleBtcHTLC(params: {
  sellerLnd: LndClient;
  preimage: Preimage;
}): Promise<void> {
  await params.sellerLnd.settleHoldInvoice(params.preimage);
}

// ── Refund ───────────────────────────────────────────────────────────────────

/**
 * Cancel the hold invoice — buyer's in-flight funds are returned.
 * Called on timelock expiry or arbitrator rejection.
 */
export async function refundBtcHTLC(params: {
  sellerLnd: LndClient;
  preimageHash: PreimageHash;
}): Promise<void> {
  await params.sellerLnd.cancelHoldInvoice(params.preimageHash);
}

// ── Poll ─────────────────────────────────────────────────────────────────────

/**
 * Poll the invoice state until it reaches a terminal state or times out.
 * Used by the buyer to confirm the HTLC is in ACCEPTED state before
 * informing the arbitrator that BTC funds are locked.
 */
export async function waitForHTLCAccepted(params: {
  sellerLnd: LndClient;
  preimageHash: PreimageHash;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<"ACCEPTED" | "SETTLED" | "CANCELED"> {
  const interval = params.pollIntervalMs ?? 2000;
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);

  while (Date.now() < deadline) {
    const inv = await params.sellerLnd.lookupInvoice(params.preimageHash);
    if (inv.state === "ACCEPTED" || inv.state === "SETTLED" || inv.state === "CANCELED") {
      return inv.state;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error("Timed out waiting for HTLC to be accepted");
}
