/**
 * LND REST client for AgentSwap.
 *
 * LND exposes a REST gateway that mirrors its gRPC surface.
 * We use it instead of gRPC to keep the dependency surface small
 * (no proto compilation step needed for a hackathon).
 *
 * Docs: https://lightning.engineering/api-docs/api/lnd/
 */

import fs from "fs";
import https from "https";
import fetch from "node-fetch";

export interface LndClientConfig {
  /** e.g. "https://localhost:8080" */
  restUrl: string;
  /** Path to LND's tls.cert — required for self-signed TLS */
  tlsCertPath: string;
  /** Optional macaroon hex string (leave empty if --no-macaroons) */
  macaroonHex?: string;
}

export class LndClient {
  private readonly baseUrl: string;
  private readonly agent: https.Agent;
  private readonly headers: Record<string, string>;

  constructor(config: LndClientConfig) {
    this.baseUrl = config.restUrl.replace(/\/$/, "");

    // LND uses a self-signed TLS certificate; we pin it explicitly
    // instead of disabling verification entirely.
    const cert = fs.existsSync(config.tlsCertPath)
      ? fs.readFileSync(config.tlsCertPath)
      : undefined;

    this.agent = new https.Agent({ ca: cert, rejectUnauthorized: !!cert });

    this.headers = { "Content-Type": "application/json" };
    if (config.macaroonHex) {
      this.headers["Grpc-Metadata-macaroon"] = config.macaroonHex;
    }
  }

  // ── Low-level HTTP ──────────────────────────────────────────────────────────

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers,
      agent: this.agent,
    });
    if (!res.ok) throw new Error(`LND GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      agent: this.agent,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LND POST ${path} → ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  // ── Node Info ───────────────────────────────────────────────────────────────

  async getInfo(): Promise<LndGetInfoResponse> {
    return this.get<LndGetInfoResponse>("/v1/getinfo");
  }

  async getWalletBalance(): Promise<{ total_balance: string }> {
    return this.get("/v1/balance/blockchain");
  }

  // ── On-chain funding ────────────────────────────────────────────────────────

  async newAddress(): Promise<{ address: string }> {
    // type 0 = p2wkh (native segwit) — cheapest fees
    return this.post("/v1/newaddress", { type: 0 });
  }

  // ── Channels ────────────────────────────────────────────────────────────────

  async listPeers(): Promise<{ peers: LndPeer[] }> {
    return this.get("/v1/peers");
  }

  async connectPeer(pubkey: string, host: string): Promise<void> {
    await this.post("/v1/peers", {
      addr: { pubkey, host },
      perm: false,
    });
  }

  async openChannel(params: OpenChannelParams): Promise<{ funding_txid_str: string }> {
    return this.post("/v1/channels", params);
  }

  async listChannels(): Promise<{ channels: LndChannel[] }> {
    return this.get("/v1/channels");
  }

  // ── Invoices / HTLCs ────────────────────────────────────────────────────────

  /**
   * Create a HOLD invoice — the key primitive for Lightning HTLCs.
   * A hold invoice is settled only when the preimage is revealed, giving
   * the seller time to verify payment before releasing the secret.
   *
   * Endpoint: POST /v2/invoices/hodl
   */
  async createHoldInvoice(params: {
    /** SHA-256 hash of the preimage (hex, 64 chars) */
    hash: string;
    /** Amount in satoshis */
    valueSat: number;
    /** Expiry in seconds */
    expiry: number;
    memo?: string;
  }): Promise<{ payment_request: string; payment_addr: string }> {
    return this.post("/v2/invoices/hodl", {
      hash: Buffer.from(params.hash, "hex").toString("base64"),
      value: params.valueSat,
      expiry: params.expiry,
      memo: params.memo ?? "AgentSwap HTLC",
      // cltv_expiry: blocks before the HTLC on-chain timelock fires
      cltv_expiry: Math.ceil((params.expiry / 3600) * 6), // ~6 blocks/hr on regtest
    });
  }

  /**
   * Settle a hold invoice by revealing the preimage.
   * Endpoint: POST /v2/invoices/settle
   */
  async settleHoldInvoice(preimageHex: string): Promise<void> {
    await this.post("/v2/invoices/settle", {
      preimage: Buffer.from(preimageHex, "hex").toString("base64"),
    });
  }

  /**
   * Cancel a hold invoice (triggers refund path).
   * Endpoint: POST /v2/invoices/cancel
   */
  async cancelHoldInvoice(paymentHashHex: string): Promise<void> {
    await this.post("/v2/invoices/cancel", {
      payment_hash: Buffer.from(paymentHashHex, "hex").toString("base64"),
    });
  }

  /**
   * Pay a Lightning invoice (buyer → seller).
   * Endpoint: POST /v2/router/send (streaming; we await final status)
   */
  async payInvoice(params: {
    paymentRequest: string;
    timeoutSeconds?: number;
    feeLimitSat?: number;
  }): Promise<{ payment_hash: string; status: string }> {
    return this.post("/v2/router/send", {
      payment_request: params.paymentRequest,
      timeout_seconds: params.timeoutSeconds ?? 60,
      fee_limit_sat: params.feeLimitSat ?? 1000,
      no_inflight_updates: true, // return only the terminal result
    });
  }

  async lookupInvoice(paymentHashHex: string): Promise<LndInvoice> {
    const b64 = Buffer.from(paymentHashHex, "hex").toString("base64url");
    return this.get<LndInvoice>(`/v2/invoices/lookup?payment_hash=${b64}`);
  }
}

// ── Response shape types (partial — only fields we use) ─────────────────────

export interface LndGetInfoResponse {
  identity_pubkey: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  block_height: number;
  synced_to_chain: boolean;
}

export interface LndPeer {
  pub_key: string;
  address: string;
  bytes_sent: string;
  bytes_recv: string;
}

export interface LndChannel {
  active: boolean;
  remote_pubkey: string;
  channel_point: string;
  capacity: string;
  local_balance: string;
  remote_balance: string;
}

export interface OpenChannelParams {
  node_pubkey_string: string;
  local_funding_amount: number; // sats
  push_sat?: number;            // sats to push to remote side immediately
  private?: boolean;
  spend_unconfirmed?: boolean;
}

export interface LndInvoice {
  payment_hash: string;
  value: string;
  settled: boolean;
  state: "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED";
  amt_paid_sat: string;
  expiry: string;
  r_preimage: string; // base64 preimage (only present after settlement)
}
