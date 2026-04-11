/**
 * Seller Agent
 *
 * Responsibilities:
 *   1. Evaluate buyer proposals and accept / counter-offer.
 *   2. Once a deal is agreed, lock ETH in the HTLC.
 *   3. Produce the deliverable for the agreed task.
 *   4. Submit the deliverable for arbitration.
 *   5. Claim the Lightning payment after arbitrator approval.
 */

import { chatJSON, chat } from "./llm.js";
import type { SwapProposal, AgentMessage } from "@agentswap/shared";

// ── System Prompt ─────────────────────────────────────────────────────────────

const SELLER_SYSTEM = `You are an autonomous AI seller agent in a trustless cross-chain atomic swap.
Your goal is to negotiate the best price for your work and deliver high-quality results.

RULES:
- Evaluate each buyer proposal on task complexity and proposed compensation.
- You may counter-offer higher prices if the task seems under-priced.
- Always ensure timelock_btc_hours >= 2 * timelock_eth_hours (protocol safety).
- After 3 rounds, accept any proposal where btcAmountSats >= 50000.
- For the deliverable, produce the BEST possible output — the arbitrator judges quality.
- Respond ONLY with valid JSON matching the requested schema. No prose outside JSON.`;

// ── Negotiation ───────────────────────────────────────────────────────────────

export async function evaluateBuyerProposal(params: {
  proposal: SwapProposal;
  round: number;
}): Promise<{
  decision: "accept" | "counter" | "reject";
  counterProposal?: Partial<SwapProposal>;
  message: string;
}> {
  type SellerDecision = {
    decision: "accept" | "counter" | "reject";
    btcAmountSats?: number;
    ethAmountWei?: string;
    timelock_btc_hours?: number;
    timelock_eth_hours?: number;
    message: string;
  };

  const result = await chatJSON<SellerDecision>({
    system: SELLER_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Negotiation round ${params.round}.

Buyer's proposal:
- Task: "${params.proposal.taskDescription}"
- BTC offered: ${params.proposal.btcAmountSats.toString()} sats
- ETH offered: ${params.proposal.ethAmountWei.toString()} wei
- BTC timelock: ${params.proposal.timelock_btc_hours}h
- ETH timelock: ${params.proposal.timelock_eth_hours}h

${params.round >= 3 ? "This is round 3+ — you should accept if btcAmountSats >= 50000." : ""}

Respond with JSON:
{
  "decision": "accept" | "counter" | "reject",
  "btcAmountSats": <number, only if counter>,
  "ethAmountWei": <string wei, only if counter>,
  "timelock_btc_hours": <number, only if counter>,
  "timelock_eth_hours": <number, only if counter>,
  "message": "<negotiation message to buyer, 1-2 sentences>"
}`,
      },
    ],
  });

  const counterProposal: Partial<SwapProposal> | undefined =
    result.decision === "counter"
      ? {
          btcAmountSats: BigInt(result.btcAmountSats ?? params.proposal.btcAmountSats),
          ethAmountWei: BigInt(result.ethAmountWei ?? params.proposal.ethAmountWei),
          timelock_btc_hours: result.timelock_btc_hours ?? params.proposal.timelock_btc_hours,
          timelock_eth_hours: result.timelock_eth_hours ?? params.proposal.timelock_eth_hours,
        }
      : undefined;

  return { decision: result.decision, counterProposal, message: result.message };
}

// ── Deliverable Production ────────────────────────────────────────────────────

/**
 * Produce the deliverable for the agreed task.
 * This is where the seller's actual "work" happens — the LLM generates output.
 */
export async function produceDeliverable(proposal: SwapProposal): Promise<string> {
  return chat({
    system: `You are a professional service provider completing a task for a client.
Produce the highest-quality output you can for the given task.
The output will be evaluated by an AI arbitrator who will decide if payment is released.
Be thorough, accurate, and professional.`,
    messages: [
      {
        role: "user",
        content: `Complete the following task to the best of your ability:

"${proposal.taskDescription}"

Produce the full deliverable now. Do not add meta-commentary — only the deliverable itself.`,
      },
    ],
    maxTokens: 2048,
  });
}

// ── Message Builder ───────────────────────────────────────────────────────────

export function buildSellerMessage(proposal: SwapProposal, content: string): AgentMessage {
  return {
    role: "seller",
    content,
    timestamp: new Date().toISOString(),
    swapId: proposal.id,
    payload: proposal,
  };
}
