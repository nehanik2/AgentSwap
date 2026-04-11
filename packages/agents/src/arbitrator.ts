/**
 * Arbitrator Agent
 *
 * The arbitrator is the trust anchor in AgentSwap — a neutral AI that:
 *   1. Evaluates the seller's deliverable against the agreed task description.
 *   2. Scores quality (0–100) and decides APPROVE or REJECT.
 *   3. On APPROVE: releases the preimage to the seller so both HTLCs can settle.
 *   4. On REJECT: signals both chains to refund.
 *
 * The arbitrator does NOT hold keys or sign transactions. It only emits a
 * verdict that the agent orchestrator acts on. In production you'd add
 * multi-sig arbitrator quorum; for the hackathon a single LLM call suffices.
 */

import { chatJSON } from "./llm.js";
import type { SwapProposal, ArbitratorVerdict, AgentMessage } from "@agentswap/shared";

// ── System Prompt ─────────────────────────────────────────────────────────────

const ARBITRATOR_SYSTEM = `You are an impartial AI arbitrator in a trustless cross-chain atomic swap escrow system.
Your sole job is to evaluate whether a seller's deliverable satisfies the agreed task description.

EVALUATION CRITERIA:
1. Completeness — does it fully address the task?
2. Accuracy — is the information correct?
3. Quality — is it professional and polished?
4. Scope — does it match what was agreed, not more, not less?

APPROVAL THRESHOLD: qualityScore >= 70 → approve. Below 70 → reject.

You must be objective and strict. The buyer's funds are at stake.
Respond ONLY with valid JSON matching the schema. No prose.`;

// ── Verdict ───────────────────────────────────────────────────────────────────

/**
 * Evaluate a deliverable and produce a verdict.
 *
 * @param preimage - Only supplied if we want the arbitrator to include it in
 *   an APPROVED verdict. In practice the orchestrator holds the preimage and
 *   passes it here only after confirming the verdict is APPROVED.
 */
export async function evaluateDeliverable(params: {
  proposal: SwapProposal;
  deliverable: string;
  preimage?: string;
}): Promise<ArbitratorVerdict> {
  type RawVerdict = {
    approved: boolean;
    qualityScore: number;
    reasoning: string;
  };

  const raw = await chatJSON<RawVerdict>({
    system: ARBITRATOR_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Evaluate this deliverable.

AGREED TASK:
"${params.proposal.taskDescription}"

SELLER'S DELIVERABLE:
---
${params.deliverable}
---

Return JSON:
{
  "approved": <boolean>,
  "qualityScore": <integer 0-100>,
  "reasoning": "<2-3 sentences explaining your verdict>"
}`,
      },
    ],
  });

  const verdict: ArbitratorVerdict = {
    swapId: params.proposal.id,
    approved: raw.approved && raw.qualityScore >= 70,
    qualityScore: raw.qualityScore,
    reasoning: raw.reasoning,
    // Only include preimage in verdict if approved — this is what unlocks funds
    preimage: raw.approved && raw.qualityScore >= 70 ? params.preimage : undefined,
    timestamp: new Date().toISOString(),
  };

  return verdict;
}

// ── Message Builder ───────────────────────────────────────────────────────────

export function buildArbitratorMessage(verdict: ArbitratorVerdict): AgentMessage {
  const status = verdict.approved ? "✅ APPROVED" : "❌ REJECTED";
  return {
    role: "arbitrator",
    content: `${status} (score: ${verdict.qualityScore}/100) — ${verdict.reasoning}`,
    timestamp: verdict.timestamp,
    swapId: verdict.swapId,
    payload: verdict,
  };
}
