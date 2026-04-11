/**
 * packages/agents/src/sellerAgent.ts
 *
 * SellerAgent — autonomous Claude-powered agent that evaluates buyer proposals,
 * negotiates ETH compensation, produces deliverables, and calls the coordinator
 * to submit work for arbitration.
 */

import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { SwapProposal, AgentMessage } from "@agentswap/shared";
import {
  callNegotiationLLM,
  NegotiationMessageSchema,
  SCHEMA_DESCRIPTION,
  type NegotiationMessage,
} from "./negotiationSchema.js";
import type { SwapCoordinator } from "./swapCoordinator.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface SellerAgentConfig {
  /** Anthropic API key for this agent's LLM calls. */
  anthropicApiKey: string;
  /** Ethereum wallet address of the seller (recipient of ETH payment). */
  walletAddress: string;
  /**
   * Minimum acceptable rate in ETH per hour of estimated work.
   * Used to anchor the initial ETH counter-offer.
   */
  minRateEthPerHour: number;
  /**
   * Claude model to use.
   * Task specification: claude-sonnet-4-20250514 (maps to claude-sonnet-4-6).
   */
  model?: string;
}

// ── System prompts ────────────────────────────────────────────────────────────

const SELLER_NEGOTIATION_SYSTEM = (minRateEthPerHour: number, walletAddress: string) =>
  `You are an autonomous AI agent acting as a seller in a cross-chain service marketplace. ` +
  `You accept payment in ETH. Negotiate for fair compensation. ` +
  `Respond ONLY with valid JSON matching the NegotiationMessage schema. Never break character.

YOUR CONSTRAINTS:
- Minimum acceptable rate: ${minRateEthPerHour} ETH/hour of estimated work
- Your Ethereum wallet: ${walletAddress}
- BTC amounts are the buyer's offer to you — you do NOT control this value
- You negotiate the ETH amount YOU will receive for completing the task
- Accept if the deal is reasonable. Counter if it's too low. Reject if insulting.
- By round 4 (seller's second turn), ACCEPT any offer >= 50% of your minimum rate

REQUIRED RESPONSE SCHEMA:
${SCHEMA_DESCRIPTION}`;

const SELLER_DELIVERABLE_SYSTEM =
  `You are a professional service provider completing a commissioned task for a client. ` +
  `Produce the highest-quality output you can — your payment depends on it. ` +
  `An AI arbitrator will evaluate your work against the agreed task description. ` +
  `Be thorough, accurate, and professional. Output only the deliverable — no meta-commentary.`;

// ── SellerAgent ───────────────────────────────────────────────────────────────

export class SellerAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  readonly config: Readonly<Required<SellerAgentConfig>>;

  constructor(config: SellerAgentConfig) {
    this.config = {
      model: process.env.AGENT_MODEL ?? "claude-sonnet-4-6",
      ...config,
    };
    this.model = this.config.model;
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  // ── evaluateProposal ────────────────────────────────────────────────────────

  /**
   * Evaluate a buyer's PROPOSE or COUNTER message and decide whether to
   * ACCEPT, COUNTER with different ETH terms, or REJECT.
   *
   * Called at round 2 (initial evaluation) and optionally round 4 (final decision).
   *
   * @param message  AgentMessage from the buyer (payload is NegotiationMessage).
   * @returns NegotiationMessage from the seller's perspective.
   */
  async evaluateProposal(message: AgentMessage): Promise<NegotiationMessage> {
    const buyerOffer = NegotiationMessageSchema.parse(message.payload);
    const isRound2 = buyerOffer.round === 1;
    const responseRound = isRound2 ? 2 : 4;

    // Estimate ETH minimum based on task complexity (very rough heuristic)
    const estimatedHours = estimateTaskHours(buyerOffer.taskDescription);
    const minWei = ethToWei(this.config.minRateEthPerHour * estimatedHours);

    const ts = new Date().toISOString();
    console.log(
      `${ts} [SellerAgent] Evaluating ${buyerOffer.messageType} ` +
      `(round ${buyerOffer.round}) — buyer offers ${buyerOffer.btcAmountSats.toLocaleString()} sats | ` +
      `current ETH offer: ${buyerOffer.ethAmountWei} wei | ` +
      `estimated min: ${minWei} wei`
    );

    const msg = await callNegotiationLLM({
      client: this.client,
      model: this.model,
      system: SELLER_NEGOTIATION_SYSTEM(this.config.minRateEthPerHour, this.config.walletAddress),
      messages: [
        {
          role: "user",
          content:
            `Task to evaluate: "${buyerOffer.taskDescription}"\n\n` +
            `Buyer's offer (round ${buyerOffer.round}):\n` +
            `  BTC offered to you: ${buyerOffer.btcAmountSats.toLocaleString()} sats\n` +
            `  ETH proposed: ${buyerOffer.ethAmountWei} wei\n` +
            `  Buyer reasoning: "${buyerOffer.reasoning}"\n\n` +
            `Your minimum acceptable ETH for this task: ${minWei} wei ` +
            `(${this.config.minRateEthPerHour} ETH/h × ~${estimatedHours}h)\n` +
            `This is ROUND ${responseRound} — your response.\n` +
            `${responseRound === 4 ? "FINAL ROUND: accept any ETH >= 50% of your minimum, or reject." : ""}\n` +
            `ACCEPT if the ETH is fair. COUNTER with your required ETH if too low. Set round to ${responseRound}.`,
        },
      ],
    });

    return { ...msg, round: responseRound };
  }

  // ── signProposal ────────────────────────────────────────────────────────────

  /**
   * Simulate signing the agreed SwapProposal with the seller's wallet key.
   *
   * Uses HMAC-SHA256(walletAddress, canonicalProposalJSON). The same canonical
   * form used by BuyerAgent — so both parties sign the same bytes.
   *
   * @returns Hex-encoded simulated signature (64 chars).
   */
  async signProposal(proposal: SwapProposal): Promise<string> {
    const canonical = canonicalProposalPayload(proposal);
    const signature = crypto
      .createHmac("sha256", this.config.walletAddress)
      .update(canonical)
      .digest("hex");

    const ts = new Date().toISOString();
    console.log(
      `${ts} [SellerAgent] Signed proposal ${proposal.id.slice(0, 8)}… ` +
      `wallet=${this.config.walletAddress.slice(0, 10)}… sig=${signature.slice(0, 16)}…`
    );

    return signature;
  }

  // ── submitDeliverable ───────────────────────────────────────────────────────

  /**
   * Generate and submit the deliverable for the agreed task.
   *
   * Uses the seller's own Anthropic client (not the shared llm.ts singleton)
   * so the seller's API key and model are honoured throughout.
   *
   * Steps:
   *   1. Retrieve the swap record from the coordinator to get taskDescription.
   *   2. Call Claude to generate the actual deliverable content.
   *   3. Call coordinator.submitDeliverable() which triggers arbitration.
   *
   * @param swapId      The active swap identifier.
   * @param coordinator The SwapCoordinator managing this swap's lifecycle.
   */
  async submitDeliverable(swapId: string, coordinator: SwapCoordinator): Promise<void> {
    const record = coordinator.getSwap(swapId);
    const { taskDescription } = record.proposal;

    const ts = new Date().toISOString();
    console.log(
      `${ts} [SellerAgent] [${swapId.slice(0, 8)}…] Generating deliverable ` +
      `for task: "${taskDescription.slice(0, 60)}…"`
    );

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SELLER_DELIVERABLE_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Complete the following task to the best of your ability.\n\n` +
            `TASK:\n"${taskDescription}"\n\n` +
            `Produce the full deliverable now. Output only the deliverable itself.`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === "text");
    const deliverable = block?.type === "text" ? block.text.trim() : "";

    if (!deliverable) {
      throw new Error(`SellerAgent: LLM produced an empty deliverable for swap ${swapId}`);
    }

    console.log(
      `${new Date().toISOString()} [SellerAgent] [${swapId.slice(0, 8)}…] ` +
      `Deliverable ready (${deliverable.length} chars) — submitting to coordinator`
    );

    await coordinator.submitDeliverable(swapId, deliverable);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Rough heuristic: estimate hours needed for a task based on description length
 * and keyword complexity signals. Purely for demo purposes.
 */
function estimateTaskHours(taskDescription: string): number {
  const words = taskDescription.split(/\s+/).length;
  const complexityKeywords = [
    "translate", "summarize", "analyze", "write", "research",
    "build", "create", "design", "implement", "review",
  ];
  const hasComplex = complexityKeywords.some((k) =>
    taskDescription.toLowerCase().includes(k)
  );
  // Base 0.5h, +0.01h per word, x2 if complex keyword found
  return Math.max(0.5, (words * 0.01 + 0.5) * (hasComplex ? 2 : 1));
}

/** Convert ETH (float) to wei string (integer). */
function ethToWei(eth: number): string {
  // 1 ETH = 1e18 wei; use BigInt to avoid floating-point precision loss
  const ethScaled = Math.round(eth * 1e6); // preserve 6 decimal places
  return ((BigInt(ethScaled) * BigInt(1e18)) / 1_000_000n).toString();
}

/**
 * Canonical JSON payload for proposal signing.
 * Must match the implementation in buyerAgent.ts exactly.
 */
function canonicalProposalPayload(proposal: SwapProposal): string {
  return JSON.stringify({
    id: proposal.id,
    taskDescription: proposal.taskDescription,
    btcAmountSats: proposal.btcAmountSats.toString(),
    ethAmountWei: proposal.ethAmountWei.toString(),
    timelock_btc_hours: proposal.timelock_btc_hours,
    timelock_eth_hours: proposal.timelock_eth_hours,
    preimageHash: proposal.preimageHash,
  });
}
