/**
 * packages/server/src/routes/demo.ts
 *
 * Demo-control REST routes — designed for smooth live presentations.
 *
 * ROUTES
 * ─────────────────────────────────────────────────────────────────────────────
 *   POST  /demo/start-scenario            — run a named preset scenario
 *   POST  /demo/force-settle/:swapId      — emergency settle (bypass arbitration)
 *   POST  /demo/force-refund/:swapId      — emergency refund
 *   POST  /demo/reset                     — kill all active swaps, clear messages
 *
 * KEY DIFFERENCE FROM /swap/start
 * ─────────────────────────────────────────────────────────────────────────────
 *   /swap/start uses SellerAgent to LLM-generate the deliverable.
 *   /demo/start-scenario injects the scenario's pre-written deliverable directly
 *   into coordinator.submitDeliverable() — making the demo deterministic and fast.
 *   The ArbitratorAgent still runs a real LLM evaluation, so judges see genuine
 *   approval/rejection reasoning, not canned text.
 */

import { Router, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  runNegotiation,
  getScenario,
  type SwapCoordinator,
  type DemoScenario,
} from "@agentswap/agents";
import type { BtcLockedEvent, SwapRefundedEvent } from "@agentswap/agents";
import type { AgentMessage } from "@agentswap/shared";
import type { SSEManager }   from "../sseManager.js";
import type { MessageStore } from "../messageStore.js";

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface DemoRouterDeps {
  coordinator:  SwapCoordinator;
  sseManager:   SSEManager;
  messageStore: MessageStore;
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createDemoRouter(deps: DemoRouterDeps): Router {
  const { coordinator, sseManager, messageStore } = deps;

  const router = Router();

  // ── POST /demo/start-scenario ───────────────────────────────────────────────

  /**
   * Start a pre-defined demo scenario.
   *
   * Body: { scenarioId: string, speedMode?: 'fast'|'normal'|'narrated' }
   *
   * Returns immediately with the swapId.  The full lifecycle runs asynchronously.
   * The scenario's pre-written deliverable is injected directly — no extra LLM
   * call for generation, but the ArbitratorAgent still evaluates via LLM.
   */
  router.post(
    "/start-scenario",
    (req: Request, res: Response): void => {
      const body = req.body as { scenarioId?: string; speedMode?: string };

      if (!body.scenarioId?.trim()) {
        res.status(400).json({ error: "scenarioId is required" });
        return;
      }

      const scenario = getScenario(body.scenarioId.trim());
      if (!scenario) {
        res.status(404).json({
          error:     `Unknown scenario: "${body.scenarioId}"`,
          available: ["translation-task", "code-review-task", "bad-delivery-demo"],
        });
        return;
      }

      const swapId    = uuidv4();
      const speedMode = (body.speedMode ?? "normal") as "fast" | "normal" | "narrated";
      messageStore.init(swapId);

      res.json({ swapId, scenario: scenario.name, speedMode, message: "Demo scenario started" });

      runDemoScenarioInBackground(swapId, scenario, speedMode, coordinator, sseManager, messageStore)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[DemoRoute] runDemoScenarioInBackground error: ${msg}`);
        });
    }
  );

  // ── POST /demo/force-settle/:swapId ────────────────────────────────────────

  /**
   * Emergency settlement — skips arbitration and reveals the preimage.
   * Use only if the normal flow stalls during a live demo.
   */
  router.post(
    "/force-settle/:swapId",
    async (req: Request, res: Response): Promise<void> => {
      const { swapId } = req.params;

      try {
        await coordinator.settleSwap(swapId);
        res.json({ swapId, message: "Force-settle completed" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }
  );

  // ── POST /demo/force-refund/:swapId ────────────────────────────────────────

  /**
   * Emergency refund — cancels BTC invoice and schedules ETH refund.
   * Useful to demonstrate the failure path on demand.
   */
  router.post(
    "/force-refund/:swapId",
    async (req: Request, res: Response): Promise<void> => {
      const { swapId } = req.params;
      const body   = req.body as { reason?: string };
      const reason = body.reason?.trim() || "Force-refund triggered via demo controller";

      try {
        await coordinator.refundSwap(swapId, reason);
        res.json({ swapId, message: "Force-refund initiated", reason });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }
  );

  // ── POST /demo/reset ────────────────────────────────────────────────────────

  /**
   * Full demo reset.
   *
   * 1. Refunds all non-terminal swaps (async, best-effort).
   * 2. Clears the per-swap message store so history starts clean.
   * 3. Broadcasts a synthetic "demo_reset" event to all SSE clients so the
   *    dashboard can clear its local state.
   */
  router.post(
    "/reset",
    (_req: Request, res: Response): void => {
      const allSwaps  = coordinator.getAllSwaps();
      const active    = allSwaps.filter(
        (s) => s.state !== "SETTLED" && s.state !== "REFUNDED"
      );
      const swapIds   = allSwaps.map((s) => s.id);

      // Kick off refunds in the background — don't block the HTTP response.
      for (const swap of active) {
        coordinator
          .refundSwap(swap.id, "Demo reset")
          .catch((err: unknown) => {
            console.warn(`[DemoRoute] reset: refundSwap(${swap.id}) failed: ${
              err instanceof Error ? err.message : String(err)
            }`);
          });
      }

      // Clear message thread history
      messageStore.clearAll();

      // Notify connected dashboards
      sseManager.broadcast("demo_reset", {
        affectedSwaps: swapIds,
        timestamp:     new Date().toISOString(),
      });

      res.json({
        message:         "Demo reset initiated",
        swapsRefunded:   active.length,
        swapsTotal:      allSwaps.length,
      });
    }
  );

  return router;
}

// ── Background scenario runner ─────────────────────────────────────────────────

/**
 * Full demo lifecycle — fully async, called after the HTTP response is sent.
 *
 * Unlike the normal /swap/start flow, the deliverable is injected from the
 * scenario definition instead of being LLM-generated.  Everything else
 * (negotiation, HTLC locking, arbitration) is real.
 */
async function runDemoScenarioInBackground(
  swapId:      string,
  scenario:    DemoScenario,
  _speedMode:  "fast" | "normal" | "narrated",
  coordinator: SwapCoordinator,
  sseManager:  SSEManager,
  messageStore: MessageStore
): Promise<void> {
  const ts     = () => new Date().toISOString();
  const log    = (msg: string) =>
    console.log(`${ts()} [DemoRoute] [${swapId.slice(0, 8)}…] ${msg}`);

  const addMsg = (msg: AgentMessage): void => {
    messageStore.add(swapId, msg);
    sseManager.broadcast("negotiation_message", msg);
  };

  // ── Announce scenario ───────────────────────────────────────────────────────

  addMsg({
    role:      "buyer",
    content:   `[Demo] Scenario: "${scenario.name}"\n` +
               `Task: "${scenario.taskDescription.slice(0, 100)}…"\n` +
               `Budget: ${scenario.buyerBudgetSats.toLocaleString()} sats · ` +
               `Expected: ${scenario.expectedOutcome}`,
    timestamp: ts(),
    swapId,
  });

  // ── Phase 1: Negotiation ────────────────────────────────────────────────────

  log(`Starting negotiation for scenario "${scenario.name}"`);

  let proposal;
  try {
    proposal = await runNegotiation(
      scenario.taskDescription,
      scenario.buyerBudgetSats,
      { swapId, anthropicApiKey: process.env.ANTHROPIC_API_KEY }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Negotiation error: ${message}`);
    addMsg({ role: "arbitrator", content: `Negotiation error: ${message}`, timestamp: ts(), swapId });
    sseManager.broadcast("error", { swapId, message, timestamp: ts() });
    return;
  }

  if (!proposal) {
    log("Negotiation failed — no agreement reached");
    addMsg({
      role:      "arbitrator",
      content:   "Negotiation failed — agents could not reach an agreement. Try again.",
      timestamp: ts(),
      swapId,
    });
    sseManager.broadcast("error", { swapId, message: "Negotiation failed", timestamp: ts() });
    return;
  }

  addMsg({
    role:      "seller",
    content:
      `Agreement reached! Terms: ${Number(proposal.btcAmountSats).toLocaleString()} sats (BTC) ↔ ` +
      `${proposal.ethAmountWei.toString()} wei (ETH). Locking funds on both chains…`,
    timestamp: ts(),
    swapId,
    payload:   proposal as unknown as Record<string, unknown>,
  });

  log(`Negotiation agreed — BTC=${proposal.btcAmountSats} ETH=${proposal.ethAmountWei}`);

  // ── Phase 2: Initiate swap (ETH lock + BTC HODL invoice) ───────────────────

  try {
    await coordinator.initiateSwap(proposal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`initiateSwap failed: ${message}`);
    addMsg({ role: "arbitrator", content: `Swap initiation failed: ${message}`, timestamp: ts(), swapId });
    sseManager.broadcast("error", { swapId, message, timestamp: ts() });
    return;
  }

  // ── Phase 3: Wait for BTC lock, then inject pre-set deliverable ─────────────

  const onBtcLocked = (event: BtcLockedEvent): void => {
    if (event.swapId !== swapId) return;
    coordinator.off("btc:locked", onBtcLocked);

    addMsg({
      role:      "seller",
      content:
        `BTC locked in Lightning HTLC — submitting ${scenario.deliverableQuality === "bad" ? "😈 intentionally bad" : "✅ quality"} deliverable for arbitration…`,
      timestamp: ts(),
      swapId,
    });

    log(`BTC locked. Submitting ${scenario.deliverableQuality} deliverable (${scenario.deliverable.length} chars)`);

    // Inject the pre-written deliverable directly — bypasses LLM generation.
    // The coordinator's ArbitratorAgent still evaluates it with a real LLM call.
    coordinator
      .submitDeliverable(swapId, scenario.deliverable)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`submitDeliverable error: ${message}`);
        sseManager.broadcast("error", { swapId, message, timestamp: ts() });
      });
  };

  // Guard: clean up if swap refunds before BTC lock (e.g. invoice expired)
  const onRefunded = (event: SwapRefundedEvent): void => {
    if (event.swapId !== swapId) return;
    coordinator.off("btc:locked",   onBtcLocked);
    coordinator.off("swap:refunded", onRefunded);
  };

  coordinator.on("btc:locked",   onBtcLocked);
  coordinator.on("swap:refunded", onRefunded);
}
