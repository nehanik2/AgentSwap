/**
 * packages/agents/src/evaluationTypes.ts
 *
 * Types for the ArbitratorAgent evaluation pipeline.
 */

// ── Criteria scores ───────────────────────────────────────────────────────────

/**
 * Per-criterion scores assigned by the arbitrator when evaluating a deliverable.
 * Each criterion includes a numeric score (0–100) and a one-sentence feedback string.
 */
export interface CriteriaScores {
  /** Does the deliverable cover all explicitly requested items? */
  completeness: {
    score: number;
    feedback: string;
  };
  /** Is the output well-formed, professional, and free of obvious errors? */
  quality: {
    score: number;
    feedback: string;
  };
  /** Does the deliverable faithfully address the task as stated? */
  accuracy: {
    score: number;
    feedback: string;
  };
  /**
   * Was the deliverable submitted within the agreed protocol window?
   * For AI-generated deliverables this is typically 100 unless the submission
   * mechanism indicates a delay.
   */
  onTime: {
    score: number;
    feedback: string;
  };
}

// ── EvaluationResult ─────────────────────────────────────────────────────────

/**
 * Full structured result produced by ArbitratorAgent.evaluateDeliverable().
 *
 * This is the rich internal result — richer than the legacy `ArbitratorVerdict`
 * from `@agentswap/shared`. The coordinator stores fields from this onto the
 * internal CoordinatorSwapRecord.
 */
export interface EvaluationResult {
  /** Whether the deliverable meets the acceptance threshold (score >= 70). */
  approved: boolean;

  /** Weighted average of all criteria scores, 0–100. */
  score: number;

  /** 2–4 sentence overall assessment from the arbitrator LLM. */
  reasoning: string;

  /** Breakdown of individual criterion scores. */
  criteria: CriteriaScores;

  /** The swapId this evaluation belongs to. */
  swapId: string;

  /** ISO 8601 timestamp of when the evaluation was produced. */
  timestamp: string;
}

// ── ArbitratorDecision ───────────────────────────────────────────────────────

/**
 * The action the arbitrator directs the coordinator to take after evaluation.
 *
 * APPROVE — reveal the preimage, settle BTC, allow seller to claim ETH.
 * REJECT  — cancel BTC invoice, schedule ETH refund after timelock.
 */
export type ArbitratorDecision = "APPROVE" | "REJECT";
