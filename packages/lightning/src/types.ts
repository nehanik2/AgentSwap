/**
 * LND REST API response shapes.
 *
 * Only the fields we actually consume are typed; LND returns additional
 * fields that we intentionally ignore.
 */

// ── Raw LND wire types (what the REST API actually returns) ──────────────────

/** Response from POST /v2/invoices/hodl */
export interface LndHodlInvoiceResponse {
  /** base64-encoded payment hash */
  r_hash: string;
  /** BOLT-11 payment request string */
  payment_request: string;
  /** Monotonically increasing index for the invoice */
  add_index: string;
  /** base64-encoded 32-byte payment address */
  payment_addr: string;
}

/** Response from GET /v2/invoices/lookup?payment_hash=<base64url> */
export interface LndInvoiceLookup {
  /** base64-encoded payment hash */
  r_hash: string;
  /** base64-encoded preimage (only present after settlement) */
  r_preimage: string;
  /** Satoshi value of the invoice */
  value: string;
  /** Invoice state */
  state: LndInvoiceState;
  /** Amount actually paid in satoshis */
  amt_paid_sat: string;
  /** Unix timestamp of invoice creation */
  creation_date: string;
  /** Unix timestamp of invoice settlement (0 if unsettled) */
  settle_date: string;
  /** Expiry in seconds from creation_date */
  expiry: string;
  /** BOLT-11 payment request */
  payment_request: string;
  settled: boolean;
}

export type LndInvoiceState = "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED";

/** Response from POST /v2/router/send */
export interface LndPaymentResponse {
  /** base64-encoded payment hash */
  payment_hash: string;
  /** base64-encoded payment preimage (only on SUCCEEDED) */
  payment_preimage: string;
  /** Amount sent in satoshis */
  value_sat: string;
  /** Routing fee paid in satoshis */
  fee_sat: string;
  payment_request: string;
  status: LndPaymentStatus;
  failure_reason: string;
  creation_time_ns: string;
}

export type LndPaymentStatus =
  | "UNKNOWN"
  | "IN_FLIGHT"
  | "SUCCEEDED"
  | "FAILED";

/** Response from GET /v1/balance/channels */
export interface LndChannelBalanceResponse {
  /** Total confirmed local balance across all channels (satoshis) */
  balance: string;
  pending_open_balance: string;
  /** Confirmed local balance broken down by sat / msat */
  local_balance?: {
    sat: string;
    msat: string;
  };
  /** Confirmed remote balance broken down by sat / msat */
  remote_balance?: {
    sat: string;
    msat: string;
  };
  unsettled_local_balance?: { sat: string; msat: string };
  unsettled_remote_balance?: { sat: string; msat: string };
  pending_open_local_balance?: { sat: string; msat: string };
  pending_open_remote_balance?: { sat: string; msat: string };
}

// ── Higher-level result shapes (returned by LNDClient public methods) ────────

/** Returned by LNDClient.createHodlInvoice */
export interface HodlInvoiceResult {
  /** BOLT-11 payment request string — hand this to the payer */
  paymentRequest: string;
  /** Payment hash as a hex string (64 hex chars) */
  rHash: string;
  /** Wall-clock expiry time */
  expiryAt: Date;
}

/** Returned by LNDClient.getChannelBalance */
export interface ChannelBalance {
  /** Confirmed local balance in satoshis */
  local: number;
  /** Confirmed remote balance in satoshis */
  remote: number;
}

/** Returned by LNDClient.payInvoice */
export interface PayInvoiceResult {
  /** Payment hash as returned by LND (base64) */
  paymentHash: string;
  /** Terminal payment status */
  status: LndPaymentStatus;
}
