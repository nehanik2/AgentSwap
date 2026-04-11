/**
 * Buyer Agent
 *
 * Responsibilities:
 *   1. Generate an initial SwapProposal for a given task.
 *   2. Respond to seller counter-offers (accept or counter).
 *   3. Generate a cryptographic preimage + hash for the HTLC.
 *   4. Decide whether to pay the Lightning invoice once the seller's ETH is locked.
 *   5. Reveal the preimage after the arbitrator approves.
 *
 * The agent uses the LLM only for negotiation decisions; all crypto operations
 * are deterministic code (see packages/lightning/src/htlc.ts).
 */

import { v4 as uuidv4 } from "uuid";
import { chatJSON } from "./llm.js";
import { generatePreimage, hashPreimage } from "@agentswap/lightning";
import type {
  SwapProposal,
  AgentMessage,
  Preimage,
} from "@agentswap/shared";

// ── System Prompt ─────────────────────────────────────────────────────────────

const BUYER_SYSTEM = `You are an autonomous AI buyer agent participating in a trustless cross-chain atomic swap.
Your goal is to acquire a deliverable (described in the task) at a fair price while minimising risk.

RULES:
- You negotiate price and timelock parameters with a seller agent.
- You must always propose realistic values — btcAmountSats between 10000-1000000, ethAmountWei in wei.
- timelock_btc_hours MUST be at least 2× timelock_eth_hours (BTC needs the longer lock).
- After 3 rounds of negotiation, accept any reasonable offer to keep the demo moving.
- Respond ONLY with a valid JSON object matching the schema provided. No prose.`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an initial swap proposal for a task.
 * Returns the proposal plus the secret preimage (kept by the buyer only).
 */
export async function createProposal(taskDescription: string): Promise<{
  proposal: SwapProposal;
  preimage: Preimage;
}> {
  const preimage = generatePreimage();
  const preimageHash = hashPreimage(preimage);
  const now = new Date().toISOString();
  const id = uuidv4();

  // Ask the LLM to fill in fair pricing for this task
  type ProposalDraft = Pick<SwapProposal, "btcAmountSats" | "ethAmountWei" | "timelock_btc_hours" | "timelock_eth_hours">;
  const draft = await chatJSON<ProposalDraft>({
    system: BUYER_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Generate a fair initial swap proposal for the following task:

Task: "${taskDescription}"

Return JSON with these fields only:
{
  "btcAmountSats": <number>,
  "ethAmountWei": <string — wei as decimal>,
  "timelock_btc_hours": <number>,
  "timelock_eth_hours": <number>,
  "reasoning": "<one sentence>"
}`,
      },
    ],
  });

  const proposal: SwapProposal = {
    id,
    taskDescription,
    // JSON numbers may exceed safe integer; coerce via BigInt
    btcAmountSats: BigInt(draft.btcAmountSats),
    ethAmountWei: BigInt(draft.ethAmountWei),
    timelock_btc_hours: draft.timelock_btc_hours,
    timelock_eth_hours: draft.timelock_eth_hours,
    preimageHash,
    createdAt: now,
    updatedAt: now,
  };

  return { proposal, preimage };
}

/**
 * Evaluate a seller's counter-offer and decide:
 *   - "accept" → proceed to locking
 *   - "counter" → produce a new proposal
 *   - "reject"  → walk away (rare)
 */
export async function evaluateCounterOffer(params: {
  currentProposal: SwapProposal;
  sellerMessage: AgentMessage;
  round: number;
}): Promise<{ decision: "accept" | "counter" | "reject"; counterProposal?: SwapProposal }> {
  type DecisionResponse = {
    decision: "accept" | "counter" | "reject";
    btcAmountSats?: number;
    ethAmountWei?: string;
    timelock_btc_hours?: number;
    timelock_eth_hours?: number;
    reasoning: string;
  };

  const result = await chatJSON<DecisionResponse>({
    system: BUYER_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Negotiation round ${params.round}.

Your current proposal:
${JSON.stringify(
  {
    ...params.currentProposal,
    btcAmountSats: params.currentProposal.btcAmountSats.toString(),
    ethAmountWei: params.currentProposal.ethAmountWei.toString(),
  },
  null,
  2
)}

Seller's counter-offer message:
"${params.sellerMessage.content}"

Decide: should you accept, counter, or reject?
${params.round >= 3 ? "This is round 3+ — you should accept any reasonable offer." : ""}

Return JSON:
{
  "decision": "accept" | "counter" | "reject",
  "btcAmountSats": <number, only if counter>,
  "ethAmountWei": <string wei, only if counter>,
  "timelock_btc_hours": <number, only if counter>,
  "timelock_eth_hours": <number, only if counter>,
  "reasoning": "<one sentence>"
}`,
      },
    ],
  });

  if (result.decision === "counter") {
    const now = new Date().toISOString();
    const counterProposal: SwapProposal = {
      ...params.currentProposal,
      btcAmountSats: BigInt(result.btcAmountSats ?? params.currentProposal.btcAmountSats),
      ethAmountWei: BigInt(result.ethAmountWei ?? params.currentProposal.ethAmountWei),
      timelock_btc_hours: result.timelock_btc_hours ?? params.currentProposal.timelock_btc_hours,
      timelock_eth_hours: result.timelock_eth_hours ?? params.currentProposal.timelock_eth_hours,
      updatedAt: now,
    };
    return { decision: "counter", counterProposal };
  }

  return { decision: result.decision };
}

/**
 * Compose an AgentMessage for a given proposal to send to the seller.
 */
export function buildBuyerMessage(proposal: SwapProposal, content: string): AgentMessage {
  return {
    role: "buyer",
    content,
    timestamp: new Date().toISOString(),
    swapId: proposal.id,
    payload: proposal,
  };
}
