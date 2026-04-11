/**
 * packages/server/src/routes/swap.ts
 *
 * REST routes for swap lifecycle management.
 *
 * ROUTES
 * ─────────────────────────────────────────────────────────────────────────────
 *   POST   /swap/start                 — kick off full demo flow (non-blocking)
 *   GET    /swap/:swapId               — current record + message history
 *   GET    /swap/:swapId/messages      — full AgentMessage[] thread
 *   GET    /swaps                      — all active + completed swaps
 *   POST   /swap/:swapId/trigger-refund — demo tool: force refund path
 *
 * BACKGROUND FLOW (POST /swap/start)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Pre-generate swapId → return immediately
 *   2. runNegotiation()    → agreed SwapProposal (swapId is embedded)
 *   3. coordinator.initiateSwap() → locks ETH, creates BTC HODL invoice
 *      (awaitBtcLock runs automatically in background inside initiateSwap)
 *   4. On 'btc:locked' event → sellerAgent.submitDeliverable()
 *      → arbitrator evaluates → coordinator settles or refunds automatically
 */

import { Router, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  runNegotiation,
  type SwapCoordinator,
  type SellerAgent,
} from "@agentswap/agents";
import type { BtcLockedEvent } from "@agentswap/agents";
import type { AgentMessage } from "@agentswap/shared";
import type { SSEManager } from "../sseManager.js";
import type { MessageStore } from "../messageStore.js";

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface SwapRouterDeps {
  coordinator: SwapCoordinator;
  sseManager:  SSEManager;
  messageStore: MessageStore;
  sellerAgent:  SellerAgent;
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createSwapRouter(deps: SwapRouterDeps): Router {
  const { coordinator, sseManager, messageStore, sellerAgent } = deps;

  const router = Router();

  // ── POST /swap/start ────────────────────────────────────────────────────────

  /**
   * Start a new demo swap.
   *
   * Returns immediately with the swapId so the client can connect to SSE and
   * watch live progress. The full negotiation → lock → evaluate → settle flow
   * runs asynchronously in the background.
   *
   * Body: { taskDescription: string, buyerBudgetSats?: number }
   */
  router.post(
    "/start",
    (req: Request, res: Response): void => {
      const body = req.body as {
        taskDescription?: string;
        buyerBudgetSats?: number;
      };

      if (!body.taskDescription?.trim()) {
        res.status(400).json({ error: "taskDescription is required" });
        return;
      }

      const taskDescription  = body.taskDescription.trim();
      const buyerBudgetSats  = Math.max(1, Math.round(body.buyerBudgetSats ?? 100_000));

      // Pre-generate the swapId so we can return it before negotiation completes.
      const swapId = uuidv4();
      messageStore.init(swapId);

      // Respond immediately — client subscribes to SSE for live updates.
      res.json({ swapId, message: "Negotiation started" });

      // ── Background flow ───────────────────────────────────────────────────
      runSwapInBackground(
        swapId,
        taskDescription,
        buyerBudgetSats,
        coordinator,
        sellerAgent,
        sseManager,
        messageStore
      );
    }
  );

  // ── GET /swap/:swapId ───────────────────────────────────────────────────────

  /**
   * Return the full swap record for a given swapId.
   *
   * Combines the coordinator's public record (state, proposal, receipts, scores)
   * with the server-side message thread.
   */
  router.get(
    "/:swapId",
    (req: Request, res: Response): void => {
      const { swapId } = req.params;

      let record;
      try {
        record = coordinator.getSwap(swapId);
      } catch {
        // Swap may still be in negotiation phase (not yet in coordinator)
        if (messageStore.has(swapId)) {
          res.json({
            swapId,
            state: "NEGOTIATING",
            messages: messageStore.get(swapId),
          });
          return;
        }
        res.status(404).json({ error: `Swap ${swapId} not found` });
        return;
      }

      res.json({ ...record, messages: messageStore.get(swapId) });
    }
  );

  // ── GET /swap/:swapId/messages ──────────────────────────────────────────────

  /**
   * Return the full AgentMessage conversation history for a swap.
   */
  router.get(
    "/:swapId/messages",
    (req: Request, res: Response): void => {
      const { swapId } = req.params;

      if (!messageStore.has(swapId)) {
        // Try coordinator first — swap exists but may have no messages yet
        try {
          coordinator.getSwap(swapId);
          res.json({ swapId, messages: [] });
        } catch {
          res.status(404).json({ error: `Swap ${swapId} not found` });
        }
        return;
      }

      res.json({ swapId, messages: messageStore.get(swapId) });
    }
  );

  // ── GET /swaps ──────────────────────────────────────────────────────────────

  /**
   * Return all swaps the coordinator knows about, augmented with message counts.
   */
  router.get(
    "/",
    (_req: Request, res: Response): void => {
      const records = coordinator.getAllSwaps();

      const enriched = records.map((r) => ({
        ...r,
        messageCount: messageStore.get(r.id).length,
      }));

      res.json({ swaps: enriched, total: enriched.length });
    }
  );

  // ── POST /swap/:swapId/trigger-refund ───────────────────────────────────────

  /**
   * Demo tool: manually trigger the refund path for a swap.
   *
   * Shows judges the failure/cancellation case. Safe to call from the
   * dashboard "Force Refund" button.
   *
   * Body: { reason?: string }
   */
  router.post(
    "/:swapId/trigger-refund",
    async (req: Request, res: Response): Promise<void> => {
      const { swapId } = req.params;
      const body = req.body as { reason?: string };
      const reason = body.reason?.trim() || "Manual refund triggered via demo API";

      try {
        await coordinator.refundSwap(swapId, reason);
        res.json({ swapId, message: "Refund initiated", reason });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }
  );

  return router;
}

// ── Background swap orchestration ─────────────────────────────────────────────

/**
 * Full demo flow — runs entirely asynchronously after the HTTP response is sent.
 *
 * Phase 1 — NEGOTIATE:  BuyerAgent + SellerAgent exchange counter-offers.
 * Phase 2 — INITIATE:   coordinator.initiateSwap() locks ETH and creates BTC invoice.
 * Phase 3 — AWAIT BTC:  awaitBtcLock() runs inside initiateSwap; we listen for the event.
 * Phase 4 — DELIVER:    sellerAgent.submitDeliverable() → arbitrator evaluates → settle/refund.
 */
async function runSwapInBackground(
  swapId: string,
  taskDescription: string,
  buyerBudgetSats: number,
  coordinator: SwapCoordinator,
  sellerAgent: SellerAgent,
  sseManager: SSEManager,
  messageStore: MessageStore
): Promise<void> {
  const ts = () => new Date().toISOString();
  const log = (msg: string) =>
    console.log(`${ts()} [SwapRoute] [${swapId.slice(0, 8)}…] ${msg}`);

  const addMsg = (msg: AgentMessage) => {
    messageStore.add(swapId, msg);
    sseManager.broadcast("negotiation_message", msg);
  };

  // Phase 1 — Negotiation ────────────────────────────────────────────────────

  addMsg({
    role:      "buyer",
    content:   `Starting negotiation for task: "${taskDescription}" (budget: ${buyerBudgetSats.toLocaleString()} sats)`,
    timestamp: ts(),
    swapId,
  });

  log(`Starting negotiation — task="${taskDescription.slice(0, 60)}" budget=${buyerBudgetSats}`);

  let proposal;
  try {
    proposal = await runNegotiation(taskDescription, buyerBudgetSats, {
      swapId, // use the pre-generated ID so coordinator records match
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Negotiation threw: ${message}`);
    addMsg({ role: "arbitrator", content: `Negotiation error: ${message}`, timestamp: ts(), swapId });
    sseManager.broadcast("error", { swapId, message, timestamp: ts() });
    return;
  }

  if (!proposal) {
    log("Negotiation failed — no agreement reached");
    addMsg({
      role:      "arbitrator",
      content:   "Negotiation failed — agents could not reach an agreement.",
      timestamp: ts(),
      swapId,
    });
    sseManager.broadcast("error", {
      swapId,
      message: "Negotiation failed — no agreement reached",
      timestamp: ts(),
    });
    return;
  }

  addMsg({
    role:    "seller",
    content: `Agreement reached! Terms: ${Number(proposal.btcAmountSats).toLocaleString()} sats (BTC) ↔ ${proposal.ethAmountWei.toString()} wei (ETH). Locking funds…`,
    timestamp: ts(),
    swapId,
    payload:   proposal,
  });

  log(`Negotiation agreed — BTC=${proposal.btcAmountSats} sats ETH=${proposal.ethAmountWei} wei`);

  // Phase 2 — Initiate swap (locks ETH + creates BTC HODL invoice) ───────────

  try {
    await coordinator.initiateSwap(proposal);
    // initiateSwap starts awaitBtcLock() in the background automatically
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`initiateSwap failed: ${message}`);
    addMsg({ role: "arbitrator", content: `Swap initiation failed: ${message}`, timestamp: ts(), swapId });
    sseManager.broadcast("error", { swapId, message, timestamp: ts() });
    return;
  }

  // Phase 3 — Wait for BTC lock, then trigger deliverable ───────────────────

  // Register a one-shot listener. awaitBtcLock runs in the background inside
  // initiateSwap so we race to register before it resolves (safe — Lightning
  // payments take at least a few seconds in any real environment).

  const onBtcLocked = (event: BtcLockedEvent) => {
    if (event.swapId !== swapId) return; // ignore events for other swaps
    coordinator.off("btc:locked", onBtcLocked);

    // Phase 4 — Deliver (async, errors handled internally) ───────────────────
    submitDeliverable(swapId, coordinator, sellerAgent, sseManager, messageStore)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`submitDeliverable threw: ${message}`);
        sseManager.broadcast("error", { swapId, message, timestamp: ts() });
      });
  };

  coordinator.on("btc:locked", onBtcLocked);

  // Guard: if the swap ends in REFUNDED before BTC lock (e.g. invoice cancelled),
  // clean up the dangling listener so it doesn't fire later for another swap.
  const onRefunded = (event: { swapId: string }) => {
    if (event.swapId !== swapId) return;
    coordinator.off("btc:locked",   onBtcLocked);
    coordinator.off("swap:refunded", onRefunded);
  };
  coordinator.on("swap:refunded", onRefunded);
}

/**
 * Have the seller produce and submit the deliverable, then let the coordinator's
 * built-in arbitrator evaluate it and settle or refund automatically.
 */
async function submitDeliverable(
  swapId: string,
  coordinator: SwapCoordinator,
  sellerAgent: SellerAgent,
  sseManager: SSEManager,
  messageStore: MessageStore
): Promise<void> {
  const ts = () => new Date().toISOString();

  messageStore.add(swapId, {
    role:      "seller",
    content:   "BTC locked — generating deliverable…",
    timestamp: ts(),
    swapId,
  });

  try {
    // submitDeliverable calls coordinator.submitDeliverable() internally, which
    // transitions to EVALUATING and triggers the ArbitratorAgent automatically.
    await sellerAgent.submitDeliverable(swapId, coordinator);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    messageStore.add(swapId, {
      role:      "arbitrator",
      content:   `Deliverable submission failed: ${message}`,
      timestamp: ts(),
      swapId,
    });
    sseManager.broadcast("error", { swapId, message, timestamp: ts() });
    throw err;
  }
}
