/**
 * packages/agents/src/index.ts
 *
 * Barrel export for the agents package.
 * Also exports runNegotiation() — the top-level orchestration function.
 */

import { v4 as uuidv4 } from "uuid";
import type { SwapProposal, AgentMessage } from "@agentswap/shared";
import { BuyerAgent, type BuyerAgentConfig } from "./buyerAgent.js";
import { SellerAgent, type SellerAgentConfig } from "./sellerAgent.js";
import { MessageBus } from "./messageBus.js";
import type { NegotiationMessage } from "./negotiationSchema.js";

// ── Re-exports ────────────────────────────────────────────────────────────────

// New: negotiation agents + bus
export { BuyerAgent } from "./buyerAgent.js";
export type { BuyerAgentConfig } from "./buyerAgent.js";
export { SellerAgent } from "./sellerAgent.js";
export type { SellerAgentConfig } from "./sellerAgent.js";
export { MessageBus } from "./messageBus.js";
export type { BusMessage } from "./messageBus.js";
export {
  NegotiationMessageSchema,
  parseNegotiationMessage,
  callNegotiationLLM,
  SCHEMA_DESCRIPTION,
} from "./negotiationSchema.js";
export type { NegotiationMessage } from "./negotiationSchema.js";

// SwapCoordinator
export { SwapCoordinator } from "./swapCoordinator.js";
export { SwapStore } from "./swapStore.js";
export type {
  HTLCClient,
  SwapCoordinatorConfig,
  CoordinatorSwapRecord,
  PublicSwapRecord,
} from "./types.js";

// ArbitratorAgent + vault + evaluation types
export { ArbitratorAgent } from "./arbitratorAgent.js";
export type { ArbitratorAgentConfig } from "./arbitratorAgent.js";
export { ARBITRATOR_SYSTEM_PROMPT, EVALUATION_PROMPT } from "./arbitratorAgent.js";
export { PreimageVault } from "./preimageVault.js";
export type {
  EvaluationResult,
  CriteriaScores,
  ArbitratorDecision,
} from "./evaluationTypes.js";
export type {
  CoordinatorEventMap,
  StateChangeEvent,
  BtcLockedEvent,
  BtcPaymentRequestEvent,
  DeliverableSubmittedEvent,
  SwapSettledEvent,
  SwapRefundedEvent,
  CoordinatorErrorEvent,
} from "./events.js";

// SwapOrchestrator (legacy)
export { SwapOrchestrator } from "./orchestrator.js";
export type { OrchestratorEvents } from "./orchestrator.js";

// Agent helpers (functional-style, used internally)
export { createProposal, evaluateCounterOffer, buildBuyerMessage } from "./buyer.js";
export { evaluateBuyerProposal, produceDeliverable, buildSellerMessage } from "./seller.js";
export { evaluateDeliverable, buildArbitratorMessage } from "./arbitrator.js";
export { chat, chatJSON } from "./llm.js";

// ── runNegotiation ────────────────────────────────────────────────────────────

/**
 * Configuration for runNegotiation.
 * All fields are optional — missing values fall back to environment variables.
 */
export interface RunNegotiationConfig {
  /** Anthropic API key. Defaults to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
  /** Buyer config overrides. */
  buyer?: Partial<BuyerAgentConfig>;
  /** Seller config overrides. */
  seller?: Partial<SellerAgentConfig>;
  /**
   * Pre-generated swap ID to use instead of generating a new UUID.
   * Pass this when the caller needs to know the swapId before negotiation
   * completes (e.g. the Express server needs to return it immediately).
   */
  swapId?: string;
}

/**
 * Orchestrate a full 4-round negotiation between a BuyerAgent and SellerAgent.
 *
 * PROTOCOL (per spec):
 *   Round 1 — Buyer posts initial task PROPOSE with BTC budget
 *   Round 2 — Seller responds: ACCEPT / COUNTER / REJECT
 *   Round 3 — If COUNTER: Buyer responds: ACCEPT / COUNTER
 *   Round 4 — If COUNTER: Seller makes final ACCEPT / REJECT decision
 *   Signing  — Both agents sign the agreed proposal hash
 *
 * @param task         Natural-language description of the deliverable.
 * @param buyerBudget  Buyer's BTC budget in satoshis (hard ceiling).
 * @param config       Optional overrides for API key and agent configs.
 * @returns            Agreed SwapProposal, or null if negotiation failed.
 */
export async function runNegotiation(
  task: string,
  buyerBudget: number,
  config: RunNegotiationConfig = {}
): Promise<SwapProposal | null> {
  const apiKey =
    config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";

  if (!apiKey) {
    throw new Error(
      "runNegotiation: ANTHROPIC_API_KEY is required. " +
      "Set it via environment variable or pass config.anthropicApiKey."
    );
  }

  const swapId = config.swapId ?? uuidv4();
  const bus = new MessageBus();
  const startTs = new Date().toISOString();

  console.log(
    `${startTs} [runNegotiation] Starting swap ${swapId.slice(0, 8)}… ` +
    `task="${task.slice(0, 60)}…" budget=${buyerBudget.toLocaleString()} sats`
  );

  // ── Instantiate agents ─────────────────────────────────────────────────────

  const buyer = new BuyerAgent({
    anthropicApiKey: apiKey,
    walletAddress:
      config.buyer?.walletAddress ??
      process.env.ETH_BUYER_ADDRESS ??
      "0xBuyerWallet",
    lndPubkey:
      config.buyer?.lndPubkey ??
      process.env.BUYER_LND_PUBKEY ??
      "buyer-lnd-pubkey",
    maxBudgetSats: config.buyer?.maxBudgetSats ?? buyerBudget,
    model: config.buyer?.model,
  });

  const seller = new SellerAgent({
    anthropicApiKey: apiKey,
    walletAddress:
      config.seller?.walletAddress ??
      process.env.ETH_SELLER_ADDRESS ??
      "0xSellerWallet",
    minRateEthPerHour: config.seller?.minRateEthPerHour ?? 0.001,
    model: config.seller?.model,
  });

  // ── Round 1: Buyer proposes ────────────────────────────────────────────────

  let agreedNegotiation: NegotiationMessage | null = null;

  const r1Proposal = await buyer.proposeTask(task, buyerBudget);
  const r1BuyerMsg = wrapNegotiation("buyer", swapId, r1Proposal);
  await bus.send({ from: "buyer", swapId, negotiation: r1Proposal });

  if (r1Proposal.messageType === "REJECT") {
    log(swapId, "Buyer rejected at round 1 — negotiation aborted");
    return null;
  }

  // ── Round 2: Seller evaluates ──────────────────────────────────────────────

  const r2Response = await seller.evaluateProposal(r1BuyerMsg);
  const r2SellerMsg = wrapNegotiation("seller", swapId, r2Response);
  await bus.send({ from: "seller", swapId, negotiation: r2Response });

  if (r2Response.messageType === "REJECT") {
    log(swapId, "Seller rejected at round 2 — negotiation failed");
    return null;
  }

  if (r2Response.messageType === "ACCEPT") {
    // Seller accepted buyer's initial proposal — use buyer's terms
    agreedNegotiation = r1Proposal;
    log(swapId, "Seller ACCEPTED at round 2");
  }

  // ── Round 3: Buyer responds to counter (only if seller countered) ──────────

  let r3BuyerMsg: AgentMessage | null = null;
  let r3Response: NegotiationMessage | null = null;

  if (agreedNegotiation === null && r2Response.messageType === "COUNTER") {
    r3Response = await buyer.respondToCounter(r2SellerMsg, swapId);
    r3BuyerMsg = wrapNegotiation("buyer", swapId, r3Response);
    await bus.send({ from: "buyer", swapId, negotiation: r3Response });

    if (r3Response.messageType === "REJECT") {
      log(swapId, "Buyer rejected at round 3 — negotiation failed");
      return null;
    }

    if (r3Response.messageType === "ACCEPT") {
      // Buyer accepted seller's counter — use seller's counter terms
      agreedNegotiation = r2Response;
      log(swapId, "Buyer ACCEPTED seller counter at round 3");
    }
  }

  // ── Round 4: Seller final decision (only if buyer countered again) ─────────

  if (agreedNegotiation === null && r3Response?.messageType === "COUNTER" && r3BuyerMsg !== null) {
    const r4Response = await seller.evaluateProposal(r3BuyerMsg);
    await bus.send({ from: "seller", swapId, negotiation: r4Response });

    if (r4Response.messageType === "ACCEPT") {
      // Seller accepted buyer's round-3 counter
      agreedNegotiation = r3Response;
      log(swapId, "Seller ACCEPTED at round 4 (final)");
    } else {
      log(
        swapId,
        `No agreement after 4 rounds (seller: ${r4Response.messageType}) — negotiation failed`
      );
      return null;
    }
  }

  if (agreedNegotiation === null) {
    log(swapId, "No agreement reached — negotiation failed");
    return null;
  }

  // ── Both agents sign the agreed proposal ───────────────────────────────────

  const proposal = buildSwapProposal(swapId, task, agreedNegotiation);

  const [buyerSig, sellerSig] = await Promise.all([
    buyer.signProposal(proposal),
    seller.signProposal(proposal),
  ]);

  log(
    swapId,
    `Agreement SIGNED ✓\n` +
    `  BTC: ${agreedNegotiation.btcAmountSats.toLocaleString()} sats\n` +
    `  ETH: ${agreedNegotiation.ethAmountWei} wei\n` +
    `  Buyer sig : ${buyerSig.slice(0, 16)}…\n` +
    `  Seller sig: ${sellerSig.slice(0, 16)}…`
  );

  return proposal;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Wrap a NegotiationMessage in the shared AgentMessage type so it can be
 * passed to agent methods that accept AgentMessage.
 */
function wrapNegotiation(
  role: "buyer" | "seller",
  swapId: string,
  negotiation: NegotiationMessage
): AgentMessage {
  return {
    role,
    content: negotiation.reasoning,
    timestamp: new Date().toISOString(),
    swapId,
    // Typed as Record<string, unknown> which satisfies AgentMessage.payload
    payload: negotiation as Record<string, unknown>,
  };
}

/**
 * Build a canonical SwapProposal from the agreed NegotiationMessage.
 * The preimageHash is left empty — the SwapCoordinator fills it during
 * initiateSwap() when it generates the actual preimage.
 */
function buildSwapProposal(
  swapId: string,
  task: string,
  agreed: NegotiationMessage
): SwapProposal {
  const now = new Date().toISOString();
  return {
    id: swapId,
    taskDescription: task,
    btcAmountSats: BigInt(Math.round(agreed.btcAmountSats)),
    ethAmountWei: BigInt(agreed.ethAmountWei),
    // Timelock defaults: ETH shorter than BTC (security requirement)
    timelock_btc_hours: 48,
    timelock_eth_hours: 24,
    // Placeholder — SwapCoordinator.initiateSwap() overwrites this
    preimageHash: "",
    createdAt: now,
    updatedAt: now,
  };
}

function log(swapId: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [runNegotiation] [${swapId.slice(0, 8)}…] ${message}`);
}
