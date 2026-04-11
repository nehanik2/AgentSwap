// ── New LNDClient (HODL invoice workflow) ────────────────────────────────────
export { LNDClient } from "./lndClient.js";
export type {
  HodlInvoiceResult,
  ChannelBalance,
  PayInvoiceResult,
  LndInvoiceState,
  LndPaymentStatus,
  LndHodlInvoiceResponse,
  LndInvoiceLookup,
  LndChannelBalanceResponse,
  LndPaymentResponse,
} from "./types.js";

// ── Legacy LndClient (low-level REST wrapper) ────────────────────────────────
export { LndClient } from "./client.js";
export type { LndClientConfig, LndGetInfoResponse, LndChannel } from "./client.js";

// ── HTLC helpers ─────────────────────────────────────────────────────────────
export {
  generatePreimage,
  hashPreimage,
  lockBtcHTLC,
  payBtcHTLC,
  settleBtcHTLC,
  refundBtcHTLC,
  waitForHTLCAccepted,
} from "./htlc.js";
