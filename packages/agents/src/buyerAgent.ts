/**
 * packages/agents/src/buyerAgent.ts
 *
 * BuyerAgent — autonomous Claude-powered agent that negotiates service contracts
 * and triggers on-chain BTC locking via the swap coordinator.
 *
 * Each instance holds its own Anthropic client so multiple buyers can run
 * concurrently with different API keys, models, or budgets.
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

// ── Config ────────────────────────────────────────────────────────────────────

export interface BuyerAgentConfig {
  /** Anthropic API key for this agent's LLM calls. */
  anthropicApiKey: string;
  /** Ethereum wallet address of the buyer (used for simulated signing). */
  walletAddress: string;
  /** LND pubkey of the buyer's Lightning node. */
  lndPubkey: string;
  /** Hard budget ceiling in satoshis — the agent will never offer above this. */
  maxBudgetSats: number;
  /**
   * Claude model to use.
   * Task specification: claude-sonnet-4-20250514 (maps to claude-sonnet-4-6).
   * Overridable via this field or AGENT_MODEL env var.
   */
  model?: string;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const BUYER_SYSTEM = (maxBudgetSats: number, lndPubkey: string) =>
  `You are an autonomous AI agent acting as a buyer in a cross-chain service marketplace. ` +
  `You have a BTC budget and need a task completed. Negotiate fairly but protect your budget. ` +
  `Respond ONLY with valid JSON matching the NegotiationMessage schema. Never break character.

YOUR CONSTRAINTS:
- Maximum budget: ${maxBudgetSats.toLocaleString()} satoshis (BTC)
- Lightning node pubkey: ${lndPubkey}
- You MUST NOT offer more than your maximum budget in btcAmountSats
- After round 3, you should accept any offer at or below your budget ceiling
- ETH amounts are the seller's required payment — accept whatever they propose if BTC is within budget

REQUIRED RESPONSE SCHEMA:
${SCHEMA_DESCRIPTION}`;

// ── BuyerAgent ────────────────────────────────────────────────────────────────

export class BuyerAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  readonly config: Readonly<Required<BuyerAgentConfig>>;

  constructor(config: BuyerAgentConfig) {
    this.config = {
      model: process.env.AGENT_MODEL ?? "claude-sonnet-4-6",
      ...config,
    };
    this.model = this.config.model;
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  // ── proposeTask ─────────────────────────────────────────────────────────────

  /**
   * Round 1: Generate an initial PROPOSE message for a task.
   *
   * @param taskDescription  Natural-language description of the work requested.
   * @param budgetSats       Intended BTC offer (clamped to maxBudgetSats).
   * @returns NegotiationMessage with messageType PROPOSE and round 1.
   */
  async proposeTask(
    taskDescription: string,
    budgetSats: number
  ): Promise<NegotiationMessage> {
    const effectiveBudget = Math.min(budgetSats, this.config.maxBudgetSats);
    const ts = new Date().toISOString();
    console.log(
      `${ts} [BuyerAgent] Proposing task: "${taskDescription.slice(0, 60)}…" ` +
      `budget=${effectiveBudget.toLocaleString()} sats`
    );

    const msg = await callNegotiationLLM({
      client: this.client,
      model: this.model,
      system: BUYER_SYSTEM(this.config.maxBudgetSats, this.config.lndPubkey),
      messages: [
        {
          role: "user",
          content:
            `You want to commission the following task:\n"${taskDescription}"\n\n` +
            `Your intended BTC offer: ${effectiveBudget.toLocaleString()} satoshis\n` +
            `This is ROUND 1 — generate your initial PROPOSE message.\n` +
            `Set messageType to "PROPOSE" and round to 1.\n` +
            `Propose a fair opening offer. You may start slightly below your max to leave room to negotiate.`,
        },
      ],
    });

    // Hard-enforce budget: LLM must not exceed the ceiling
    const enforced: NegotiationMessage = {
      ...msg,
      messageType: "PROPOSE",
      round: 1,
      btcAmountSats:
        msg.btcAmountSats > this.config.maxBudgetSats
          ? effectiveBudget
          : msg.btcAmountSats,
    };

    return enforced;
  }

  // ── respondToCounter ────────────────────────────────────────────────────────

  /**
   * Round 3: Respond to a seller counter-offer.
   *
   * Reads the seller's NegotiationMessage from `message.payload`, asks Claude
   * whether to ACCEPT, COUNTER, or REJECT, then enforces the budget ceiling.
   *
   * @param message  AgentMessage from the seller (payload is NegotiationMessage).
   * @param swapId   Active swap identifier (for logging).
   * @returns NegotiationMessage with round set to 3.
   */
  async respondToCounter(message: AgentMessage, swapId: string): Promise<NegotiationMessage> {
    // Safely parse the seller's offer out of the AgentMessage payload
    const sellerOffer = NegotiationMessageSchema.parse(message.payload);
    const round = 3;

    const ts = new Date().toISOString();
    console.log(
      `${ts} [BuyerAgent] [${swapId.slice(0, 8)}…] Responding to COUNTER ` +
      `(seller wants ${sellerOffer.btcAmountSats.toLocaleString()} sats / ` +
      `${sellerOffer.ethAmountWei} wei)`
    );

    const msg = await callNegotiationLLM({
      client: this.client,
      model: this.model,
      system: BUYER_SYSTEM(this.config.maxBudgetSats, this.config.lndPubkey),
      messages: [
        {
          role: "user",
          content:
            `Swap ID: ${swapId}\n` +
            `Task: "${sellerOffer.taskDescription}"\n\n` +
            `The seller has sent a COUNTER-OFFER (round ${sellerOffer.round}):\n` +
            `  BTC requested: ${sellerOffer.btcAmountSats.toLocaleString()} sats\n` +
            `  ETH requested: ${sellerOffer.ethAmountWei} wei\n` +
            `  Seller reasoning: "${sellerOffer.reasoning}"\n\n` +
            `Your max budget is ${this.config.maxBudgetSats.toLocaleString()} sats.\n` +
            `This is ROUND ${round} — your final chance to negotiate before the protocol ends.\n` +
            `ACCEPT if the BTC amount is within your budget. COUNTER only if it's slightly over. ` +
            `REJECT only if completely unreasonable.\n` +
            `Set round to ${round}.`,
        },
      ],
    });

    // Budget enforcement: if LLM chose ACCEPT but seller asked too much → force a COUNTER
    if (msg.messageType === "ACCEPT" && sellerOffer.btcAmountSats > this.config.maxBudgetSats) {
      console.log(
        `${new Date().toISOString()} [BuyerAgent] [${swapId.slice(0, 8)}…] ` +
        `Budget override: seller wants ${sellerOffer.btcAmountSats} > max ${this.config.maxBudgetSats}, forcing COUNTER`
      );
      return {
        ...msg,
        messageType: "COUNTER",
        btcAmountSats: this.config.maxBudgetSats,
        reasoning: `My hard ceiling is ${this.config.maxBudgetSats.toLocaleString()} sats — I cannot go higher.`,
        round,
      };
    }

    return { ...msg, round };
  }

  // ── signProposal ────────────────────────────────────────────────────────────

  /**
   * Simulate signing the agreed SwapProposal with the buyer's wallet key.
   *
   * Uses HMAC-SHA256(walletAddress, canonicalProposalJSON) as a deterministic
   * stand-in for a real ECDSA signature. Both parties sign the same canonical
   * payload, so the signatures are independently verifiable.
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
      `${ts} [BuyerAgent] Signed proposal ${proposal.id.slice(0, 8)}… ` +
      `wallet=${this.config.walletAddress.slice(0, 10)}… sig=${signature.slice(0, 16)}…`
    );

    return signature;
  }

  // ── onSettled ───────────────────────────────────────────────────────────────

  /**
   * Called by the orchestrator after both HTLCs settle.
   * Logs the final settlement confirmation with on-chain tx IDs.
   */
  async onSettled(
    swapId: string,
    txIds: { btc: string; eth: string }
  ): Promise<void> {
    const ts = new Date().toISOString();
    console.log(
      `${ts} [BuyerAgent] ✓ SWAP SETTLED\n` +
      `  Swap   : ${swapId}\n` +
      `  BTC tx : ${txIds.btc}\n` +
      `  ETH tx : ${txIds.eth}\n` +
      `  Wallet : ${this.config.walletAddress}`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Canonical JSON payload for proposal signing.
 * BigInt fields are serialized as strings to avoid JSON.stringify issues.
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
