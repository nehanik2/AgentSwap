/**
 * packages/server/src/index.ts
 *
 * AgentSwap Express API server — entry point.
 *
 * RESPONSIBILITIES
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Build all singleton services (coordinator, SSE manager, message store).
 *   2. Wire SwapCoordinator events → SSE broadcast + message store population.
 *   3. Mount REST routes (/swap/*, /events) and health check.
 *   4. Start the HTTP server.
 *
 * ENVIRONMENT VARIABLES
 * ─────────────────────────────────────────────────────────────────────────────
 *   Required:
 *     ANTHROPIC_API_KEY          Anthropic SDK key (arbitrator + negotiation)
 *
 *   LND (seller node for HODL invoices):
 *     SELLER_LND_REST_URL        default: https://localhost:8081
 *     SELLER_LND_MACAROON        base64 admin macaroon, or "" (--no-macaroons)
 *
 *   Ethereum (buyer HTLC client):
 *     ETH_RPC_URL                default: http://localhost:8545
 *     ETH_BUYER_PRIVATE_KEY      0x-prefixed buyer signing key
 *     ETH_HTLC_CONTRACT_ADDRESS  deployed AgentSwapHTLC contract
 *
 *   Agent config:
 *     ETH_SELLER_ADDRESS         seller's Ethereum address (for ETH lock + claim)
 *     AGENT_MODEL                Claude model override (default: claude-sonnet-4-6)
 *     SELLER_MIN_RATE_ETH        min ETH/hour for seller (default: 0.001)
 *
 *   Server:
 *     SERVER_PORT                default: 3001
 *     CORS_ORIGIN                default: * (all origins)
 */

import * as dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";

import { LNDClient } from "@agentswap/lightning";
import { AgentSwapHTLCClient } from "@agentswap/ethereum";
import {
  SwapCoordinator,
  SellerAgent,
} from "@agentswap/agents";
import type {
  StateChangeEvent,
  BtcPaymentRequestEvent,
  BtcLockedEvent,
  DeliverableSubmittedEvent,
  SwapSettledEvent,
  SwapRefundedEvent,
  CoordinatorErrorEvent,
} from "@agentswap/agents";

import { SSEManager }   from "./sseManager.js";
import { MessageStore } from "./messageStore.js";
import { requestLogger } from "./middleware/logger.js";
import { createSwapRouter } from "./routes/swap.js";
import { createEventsRouter } from "./routes/events.js";
import { createDemoRouter } from "./routes/demo.js";

// ── Environment ───────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY ?? "";
const SELLER_LND_REST_URL       = process.env.SELLER_LND_REST_URL ?? "https://localhost:8081";
const SELLER_LND_MACAROON       = process.env.SELLER_LND_MACAROON ?? "";
const ETH_RPC_URL               = process.env.ETH_RPC_URL ?? "http://localhost:8545";
const ETH_BUYER_PRIVATE_KEY     = process.env.ETH_BUYER_PRIVATE_KEY ?? "";
const ETH_HTLC_CONTRACT_ADDRESS = process.env.ETH_HTLC_CONTRACT_ADDRESS ?? "";
const ETH_SELLER_ADDRESS        = process.env.ETH_SELLER_ADDRESS ?? "";
const SELLER_MIN_RATE_ETH       = Number(process.env.SELLER_MIN_RATE_ETH ?? "0.001");
const SERVER_PORT               = Number(process.env.SERVER_PORT ?? "3001");
const CORS_ORIGIN               = process.env.CORS_ORIGIN ?? "*";

if (!ANTHROPIC_API_KEY) {
  console.error(
    "[AgentSwap Server] FATAL: ANTHROPIC_API_KEY is not set. " +
    "Export it before starting the server."
  );
  process.exit(1);
}

// ── Services ──────────────────────────────────────────────────────────────────

// Seller's LND node — creates + settles + cancels HODL invoices
const sellerLnd = new LNDClient(SELLER_LND_REST_URL, SELLER_LND_MACAROON);

// Buyer's ETH HTLC client — locks ETH in the AgentSwapHTLC contract
const htlcClient = new AgentSwapHTLCClient({
  rpcUrl:          ETH_RPC_URL,
  privateKey:      ETH_BUYER_PRIVATE_KEY,
  contractAddress: ETH_HTLC_CONTRACT_ADDRESS,
});

// Central swap coordinator — the single source of truth for all swap state
const coordinator = new SwapCoordinator(
  sellerLnd,
  htlcClient,
  ANTHROPIC_API_KEY,
  { sellerEthAddress: ETH_SELLER_ADDRESS }
);

// Seller AI — produces deliverables and submits them for arbitration
const sellerAgent = new SellerAgent({
  anthropicApiKey:   ANTHROPIC_API_KEY,
  walletAddress:     ETH_SELLER_ADDRESS,
  minRateEthPerHour: SELLER_MIN_RATE_ETH,
});

// SSE client pool — broadcasts coordinator events to all dashboard connections
const sseManager = new SSEManager();

// Per-swap message thread — synthetic AgentMessage log built from events
const messageStore = new MessageStore();

// ── Wire coordinator events → SSE + message store ────────────────────────────

/**
 * Every coordinator event is:
 *   a) Broadcast to all connected SSE clients via sseManager.
 *   b) Converted to a human-readable AgentMessage and stored for GET /messages.
 *
 * Event names use underscores (state_change) for SSE compatibility; the
 * coordinator uses colons internally (state:change).
 */
function wireCoordinator(): void {
  const ts = () => new Date().toISOString();

  coordinator.on("state:change", (e: StateChangeEvent) => {
    sseManager.broadcast("state_change", e);
  });

  coordinator.on("btc:payment_request", (e: BtcPaymentRequestEvent) => {
    sseManager.broadcast("btc_payment_request", e);
    messageStore.add(e.swapId, {
      role:      "buyer",
      content:   `Lightning invoice ready — pay to lock BTC:\n${e.paymentRequest}\n(expires ${e.expiryAt})`,
      timestamp: e.timestamp,
      swapId:    e.swapId,
      payload:   e as unknown as Record<string, unknown>,
    });
  });

  coordinator.on("btc:locked", (e: BtcLockedEvent) => {
    sseManager.broadcast("btc_locked", e);
    messageStore.add(e.swapId, {
      role:      "buyer",
      content:   `BTC successfully locked in Lightning HTLC (rHash: ${e.rHash.slice(0, 12)}…). Waiting for seller's deliverable.`,
      timestamp: e.timestamp,
      swapId:    e.swapId,
    });
  });

  coordinator.on("deliverable:submitted", (e: DeliverableSubmittedEvent) => {
    sseManager.broadcast("deliverable_submitted", e);
    messageStore.add(e.swapId, {
      role:      "seller",
      content:   e.deliverablePreview,
      timestamp: e.timestamp,
      swapId:    e.swapId,
    });
    messageStore.add(e.swapId, {
      role:      "arbitrator",
      content:   "Deliverable received — evaluating against the original task specification…",
      timestamp: ts(),
      swapId:    e.swapId,
    });
  });

  coordinator.on("swap:settled", (e: SwapSettledEvent) => {
    sseManager.broadcast("swap_settled", e);
    messageStore.add(e.swapId, {
      role:      "arbitrator",
      content:
        `✅ APPROVED — Swap settled on both chains.\n` +
        `Preimage revealed: 0x${e.preimageHex.slice(0, 16)}…\n` +
        `Seller can now claim ETH using this preimage.`,
      timestamp: e.timestamp,
      swapId:    e.swapId,
      payload:   e as unknown as Record<string, unknown>,
    });
  });

  coordinator.on("swap:refunded", (e: SwapRefundedEvent) => {
    sseManager.broadcast("swap_refunded", e);
    messageStore.add(e.swapId, {
      role:      "arbitrator",
      content:   `❌ REJECTED — Funds refunded. Reason: ${e.reason}`,
      timestamp: e.timestamp,
      swapId:    e.swapId,
      payload:   e as unknown as Record<string, unknown>,
    });
  });

  coordinator.on("error", (e: CoordinatorErrorEvent) => {
    sseManager.broadcast("error", e);
  });
}

wireCoordinator();

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// BigInt-safe JSON serialiser — BigInt fields become numeric strings
app.set("json replacer", (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value
);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(requestLogger);

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(
  "/swap",
  createSwapRouter({ coordinator, sseManager, messageStore, sellerAgent })
);

app.use(
  "/events",
  createEventsRouter({ coordinator, sseManager })
);

app.use(
  "/demo",
  createDemoRouter({ coordinator, sseManager, messageStore })
);

// Health-check — useful for Docker HEALTHCHECK and load-balancer probes
app.get("/health", (_req, res) => {
  res.json({
    status:      "ok",
    sseClients:  sseManager.getClientCount(),
    activeSwaps: coordinator.getAllSwaps().length,
    timestamp:   new Date().toISOString(),
  });
});

// Catch-all 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Keep-alive ping (prevents proxy / load-balancer SSE timeouts) ─────────────

sseManager.startKeepAlive(20_000);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(SERVER_PORT, () => {
  console.log(
    `\n[AgentSwap Server] Listening on http://localhost:${SERVER_PORT}\n` +
    `  POST  /swap/start                   → kick off demo\n` +
    `  GET   /swap/:id                     → swap state\n` +
    `  GET   /swap/:id/messages            → message thread\n` +
    `  GET   /swaps                        → all swaps\n` +
    `  POST  /swap/:id/trigger-refund      → force refund (demo)\n` +
    `  POST  /demo/start-scenario          → run preset scenario\n` +
    `  POST  /demo/force-settle/:id        → emergency settle\n` +
    `  POST  /demo/force-refund/:id        → emergency refund\n` +
    `  POST  /demo/reset                   → reset all state\n` +
    `  GET   /events                       → SSE stream\n` +
    `  GET   /health                       → health check\n`
  );
});
