/**
 * LNDClient — high-level Lightning HTLC client for AgentSwap.
 *
 * Wraps LND's REST API (https://lightning.engineering/api-docs/api/lnd/)
 * for the HODL invoice workflow that drives the BTC leg of the atomic swap.
 *
 * Design notes
 * ─────────────
 * • Constructor accepts a base64-encoded macaroon (the format Docker LND
 *   exports) and converts it to hex for the `Grpc-Metadata-macaroon` header.
 *   Pass an empty string when running with --no-macaroons (the Docker default).
 *
 * • TLS: LND uses a self-signed certificate. We disable strict verification
 *   here so no cert pinning is required from callers. For production use,
 *   inject the CA cert via a custom https.Agent.
 *
 * • All rHash values in our public API are hex strings (64 hex chars).
 *   Internally we convert to/from base64 as required by LND.
 */

import crypto from "crypto";
import https from "https";
import fetch from "node-fetch";
import type {
  LndHodlInvoiceResponse,
  LndInvoiceLookup,
  LndChannelBalanceResponse,
  LndPaymentResponse,
  HodlInvoiceResult,
  ChannelBalance,
  PayInvoiceResult,
} from "./types.js";

export class LNDClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly agent: https.Agent;

  /**
   * @param baseUrl   LND REST URL, e.g. "https://localhost:8080"
   * @param macaroon  base64-encoded admin macaroon, or "" for --no-macaroons
   */
  constructor(baseUrl: string, macaroon: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");

    // LND uses self-signed TLS; skip verification for local/Docker setups.
    // For production, create an Agent with { ca: fs.readFileSync(tlsCertPath) }.
    this.agent = new https.Agent({ rejectUnauthorized: false });

    this.headers = { "Content-Type": "application/json" };

    if (macaroon) {
      // LND REST expects the macaroon as a hex string in this header.
      const hexMacaroon = Buffer.from(macaroon, "base64").toString("hex");
      this.headers["Grpc-Metadata-macaroon"] = hexMacaroon;
    }
  }

  // ── Preimage ────────────────────────────────────────────────────────────────

  /**
   * Generate a cryptographically random 32-byte preimage.
   *
   * The returned `preimageHash` (SHA-256 of the preimage) is committed to both
   * the Lightning HODL invoice and the Ethereum HTLC contract. The `preimage`
   * itself is kept secret until the arbitrator approves the deliverable.
   */
  generatePreimage(): { preimage: Buffer; preimageHash: Buffer } {
    const preimage = crypto.randomBytes(32);
    const preimageHash = crypto.createHash("sha256").update(preimage).digest();
    return { preimage, preimageHash };
  }

  // ── HODL Invoice ────────────────────────────────────────────────────────────

  /**
   * Create a HODL invoice on this LND node.
   *
   * A HODL invoice is NOT automatically settled when payment arrives. It holds
   * the incoming HTLC in ACCEPTED state until the node operator calls
   * `settleInvoice` (happy path) or `cancelInvoice` (refund path).
   *
   * Endpoint: POST /v2/invoices/hodl
   *
   * @param preimageHash  SHA-256 hash of the preimage (raw bytes, 32 bytes)
   * @param amountSats    Invoice value in satoshis
   * @param expirySeconds Invoice expiry in seconds from now
   */
  async createHodlInvoice(
    preimageHash: Buffer,
    amountSats: number,
    expirySeconds: number
  ): Promise<HodlInvoiceResult> {
    if (preimageHash.length !== 32) {
      throw new Error(`preimageHash must be 32 bytes, got ${preimageHash.length}`);
    }

    const resp = await this.lndPost<LndHodlInvoiceResponse>("/v2/invoices/hodl", {
      // LND expects base64-encoded hash
      hash: preimageHash.toString("base64"),
      value: amountSats,
      expiry: expirySeconds,
      memo: "AgentSwap HTLC",
      // CLTV delta: give ~6 blocks per hour of expiry, minimum 40
      cltv_expiry: Math.max(40, Math.ceil((expirySeconds / 3600) * 6)),
    });

    // LND returns r_hash as base64; expose it as hex to callers
    const rHash = Buffer.from(resp.r_hash, "base64").toString("hex");
    const expiryAt = new Date(Date.now() + expirySeconds * 1000);

    return { paymentRequest: resp.payment_request, rHash, expiryAt };
  }

  // ── Wait for Payment ────────────────────────────────────────────────────────

  /**
   * Poll the invoice state every 2 seconds until the payer's HTLC arrives
   * (ACCEPTED) or the invoice is cancelled/expired (CANCELED).
   *
   * The ACCEPTED state means funds are locked in-flight — the buyer cannot
   * reclaim them without the preimage. This is the signal to proceed to the
   * EVALUATING phase of the swap.
   *
   * @param rHash  Payment hash as a hex string (returned by createHodlInvoice)
   * @returns "ACCEPTED" when funds are locked, "CANCELED" on failure/timeout
   */
  async waitForPayment(rHash: string): Promise<"ACCEPTED" | "CANCELED"> {
    const POLL_MS = 2_000;
    const TIMEOUT_MS = 300_000; // 5 min — caller controls outer timeout
    const deadline = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      const inv = await this.lookupInvoice(rHash);

      if (inv.state === "ACCEPTED") return "ACCEPTED";
      if (inv.state === "CANCELED") return "CANCELED";
      // SETTLED is a terminal success — treat identically to ACCEPTED for callers
      if (inv.state === "SETTLED") return "ACCEPTED";

      await sleep(POLL_MS);
    }

    throw new Error(
      `waitForPayment timed out after ${TIMEOUT_MS / 1000}s for rHash=${rHash}`
    );
  }

  // ── Settle Invoice ──────────────────────────────────────────────────────────

  /**
   * Reveal the preimage to settle the HODL invoice.
   *
   * This is the moment BTC settlement becomes final. Once called, the payer
   * cannot reclaim their funds — make sure the arbitrator has approved before
   * calling this.
   *
   * Endpoint: POST /v2/invoices/settle
   *
   * @param preimage  The 32-byte preimage (raw bytes, NOT the hash)
   */
  async settleInvoice(preimage: Buffer): Promise<void> {
    if (preimage.length !== 32) {
      throw new Error(`preimage must be 32 bytes, got ${preimage.length}`);
    }
    await this.lndPost<Record<string, never>>("/v2/invoices/settle", {
      preimage: preimage.toString("base64"),
    });
  }

  // ── Cancel Invoice ──────────────────────────────────────────────────────────

  /**
   * Cancel the HODL invoice, triggering the refund path.
   *
   * Any in-flight HTLC is released back to the payer. Safe to call even if
   * the invoice hasn't been paid yet (transitions OPEN → CANCELED).
   *
   * Endpoint: POST /v2/invoices/cancel
   *
   * @param rHash  Payment hash as a hex string (returned by createHodlInvoice)
   */
  async cancelInvoice(rHash: string): Promise<void> {
    await this.lndPost<Record<string, never>>("/v2/invoices/cancel", {
      payment_hash: Buffer.from(rHash, "hex").toString("base64"),
    });
  }

  // ── Pay Invoice ─────────────────────────────────────────────────────────────

  /**
   * Pay a BOLT-11 invoice (buyer → seller).
   *
   * Used in the swap flow to lock the buyer's BTC in the seller's HODL invoice.
   * The call blocks until a terminal status is reached (SUCCEEDED or FAILED).
   *
   * Endpoint: POST /v2/router/send
   *
   * @param paymentRequest  BOLT-11 payment request string
   */
  async payInvoice(paymentRequest: string): Promise<PayInvoiceResult> {
    const resp = await this.lndPost<LndPaymentResponse>("/v2/router/send", {
      payment_request: paymentRequest,
      timeout_seconds: 60,
      fee_limit_sat: 1_000,
      // Only return the terminal result, not inflight updates
      no_inflight_updates: true,
    });

    return { paymentHash: resp.payment_hash, status: resp.status };
  }

  // ── Channel Balance ─────────────────────────────────────────────────────────

  /**
   * Return the confirmed local and remote channel balances in satoshis.
   *
   * Endpoint: GET /v1/balance/channels
   */
  async getChannelBalance(): Promise<ChannelBalance> {
    const resp = await this.lndGet<LndChannelBalanceResponse>("/v1/balance/channels");

    // Prefer the structured local_balance field; fall back to the legacy top-level
    // `balance` field for older LND versions.
    const local = parseInt(resp.local_balance?.sat ?? resp.balance ?? "0", 10);
    const remote = parseInt(resp.remote_balance?.sat ?? "0", 10);

    return { local, remote };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Look up an invoice by payment hash.
   *
   * Endpoint: GET /v2/invoices/lookup?payment_hash=<base64url>
   */
  async lookupInvoice(rHashHex: string): Promise<LndInvoiceLookup> {
    // LND's lookup endpoint requires base64url encoding (not standard base64)
    const b64url = Buffer.from(rHashHex, "hex").toString("base64url");
    return this.lndGet<LndInvoiceLookup>(
      `/v2/invoices/lookup?payment_hash=${b64url}`
    );
  }

  private async lndGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers,
      agent: this.agent,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LND GET ${path} → HTTP ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async lndPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      agent: this.agent,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LND POST ${path} → HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
