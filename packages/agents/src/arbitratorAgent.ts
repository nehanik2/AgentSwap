/**
 * packages/agents/src/arbitratorAgent.ts
 *
 * ArbitratorAgent — the trust anchor of AgentSwap.
 *
 * RESPONSIBILITIES
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Receive a seller's deliverable and the original task description.
 *   2. Call Claude with a structured evaluation prompt.
 *   3. Parse and validate the LLM's per-criterion scores.
 *   4. Produce a typed EvaluationResult with overall decision.
 *   5. Execute the decision:
 *        APPROVE → coordinator.settleSwap()   (reveals preimage on Lightning)
 *        REJECT  → coordinator.refundSwap()   (cancels BTC, schedules ETH refund)
 *   6. Maintain an in-process evaluation history for the dashboard.
 *
 * APPROVAL THRESHOLD
 * ─────────────────────────────────────────────────────────────────────────────
 *   Weighted average of criteria scores ≥ 70/100.
 *   Weights: completeness 35 %, quality 25 %, accuracy 30 %, onTime 10 %.
 *
 * PREIMAGE MANAGEMENT
 * ─────────────────────────────────────────────────────────────────────────────
 *   The ArbitratorAgent optionally accepts a PreimageVault.  When provided,
 *   it retrieves and deletes the preimage after a successful settlement so the
 *   secret does not linger in memory.  The coordinator's own preimage field is
 *   the authoritative copy — the vault is an optional second layer.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { EvaluationResult, ArbitratorDecision, CriteriaScores } from "./evaluationTypes.js";
import type { PreimageVault } from "./preimageVault.js";
import type { SwapCoordinator } from "./swapCoordinator.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface ArbitratorAgentConfig {
  /** Anthropic API key. Defaults to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
  /**
   * Claude model to use.
   * Defaults to process.env.AGENT_MODEL or "claude-sonnet-4-6".
   */
  model?: string;
  /**
   * Minimum weighted score (0–100) to approve a deliverable.
   * Defaults to 70.
   */
  approvalThreshold?: number;
  /**
   * Optional encrypted preimage vault.
   * If provided, the arbitrator cleans up entries after settlement.
   */
  vault?: PreimageVault;
}

// ── Approval threshold & weights ─────────────────────────────────────────────

const DEFAULT_THRESHOLD = 70;

const CRITERION_WEIGHTS = {
  completeness: 0.35,
  quality: 0.25,
  accuracy: 0.30,
  onTime: 0.10,
} as const;

// ── System prompt ─────────────────────────────────────────────────────────────

export const ARBITRATOR_SYSTEM_PROMPT =
  `You are an impartial AI arbitrator in a trustless cross-chain atomic swap escrow system. ` +
  `A buyer has paid BTC and a seller has submitted a deliverable. ` +
  `Your verdict determines whether the seller receives ETH payment or the buyer gets a refund. ` +
  `Be objective, thorough, and strict — real money is at stake.\n\n` +
  `EVALUATION CRITERIA (score each 0–100):\n` +
  `  completeness — Does the deliverable fully address all explicitly requested items?\n` +
  `  quality      — Is the output professional, well-formed, and free of obvious errors?\n` +
  `  accuracy     — Does the deliverable faithfully address the task as stated?\n` +
  `  onTime       — Was the deliverable submitted promptly within the agreed window? ` +
                    `(default 100 unless you have evidence of delay)\n\n` +
  `APPROVAL THRESHOLD: weighted average ≥ 70 → APPROVE. Below 70 → REJECT.\n` +
  `Weights: completeness 35 %, quality 25 %, accuracy 30 %, onTime 10 %.\n\n` +
  `RESPOND ONLY with valid JSON matching the schema provided. No prose, no markdown.`;

// ── Evaluation prompt ─────────────────────────────────────────────────────────

export function EVALUATION_PROMPT(
  taskDescription: string,
  deliverable: string
): string {
  return (
    `Evaluate this deliverable against the agreed task.\n\n` +
    `AGREED TASK:\n"${taskDescription}"\n\n` +
    `SELLER'S DELIVERABLE:\n---\n${deliverable}\n---\n\n` +
    `Return ONLY a JSON object with this exact structure:\n` +
    `{\n` +
    `  "completeness": { "score": <0-100>, "feedback": "<one sentence>" },\n` +
    `  "quality":      { "score": <0-100>, "feedback": "<one sentence>" },\n` +
    `  "accuracy":     { "score": <0-100>, "feedback": "<one sentence>" },\n` +
    `  "onTime":       { "score": <0-100>, "feedback": "<one sentence>" },\n` +
    `  "reasoning":    "<2-4 sentence overall assessment>"\n` +
    `}`
  );
}

// ── Zod schema for LLM response ───────────────────────────────────────────────

const CriterionSchema = z.object({
  score: z.number().int().min(0).max(100),
  feedback: z.string().min(1),
});

const EvaluationResponseSchema = z.object({
  completeness: CriterionSchema,
  quality: CriterionSchema,
  accuracy: CriterionSchema,
  onTime: CriterionSchema,
  reasoning: z.string().min(1),
});

type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

// ── ArbitratorAgent ───────────────────────────────────────────────────────────

export class ArbitratorAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly approvalThreshold: number;
  private readonly vault: PreimageVault | undefined;
  private readonly history: EvaluationResult[] = [];

  constructor(config: ArbitratorAgentConfig = {}) {
    const apiKey =
      config.anthropicApiKey ??
      process.env.ANTHROPIC_API_KEY ??
      "";

    if (!apiKey) {
      throw new Error(
        "ArbitratorAgent: ANTHROPIC_API_KEY is required. " +
        "Set it via environment variable or pass config.anthropicApiKey."
      );
    }

    this.client = new Anthropic({ apiKey });
    this.model =
      config.model ??
      process.env.AGENT_MODEL ??
      "claude-sonnet-4-6";
    this.approvalThreshold = config.approvalThreshold ?? DEFAULT_THRESHOLD;
    this.vault = config.vault;
  }

  // ── evaluateDeliverable ────────────────────────────────────────────────────

  /**
   * Evaluate a seller's deliverable against the original task description.
   *
   * The method calls Claude once with the structured evaluation prompt.
   * On JSON or Zod parse failure it retries once with a correction message.
   *
   * @param swapId          The swap this evaluation belongs to.
   * @param taskDescription The original agreed task description.
   * @param deliverable     The seller's full work product.
   * @returns Structured EvaluationResult including per-criterion scores and decision.
   */
  async evaluateDeliverable(
    swapId: string,
    taskDescription: string,
    deliverable: string
  ): Promise<EvaluationResult> {
    const ts = new Date().toISOString();
    console.log(
      `${ts} [ArbitratorAgent] [${swapId.slice(0, 8)}…] ` +
      `Evaluating deliverable (${deliverable.length} chars) for task: ` +
      `"${taskDescription.slice(0, 60)}${taskDescription.length > 60 ? "…" : ""}"`
    );

    const rawResponse = await this._callWithRetry(taskDescription, deliverable);

    // Compute weighted score
    const weightedScore = Math.round(
      rawResponse.completeness.score * CRITERION_WEIGHTS.completeness +
      rawResponse.quality.score      * CRITERION_WEIGHTS.quality +
      rawResponse.accuracy.score     * CRITERION_WEIGHTS.accuracy +
      rawResponse.onTime.score       * CRITERION_WEIGHTS.onTime
    );

    const approved = weightedScore >= this.approvalThreshold;

    const criteria: CriteriaScores = {
      completeness: rawResponse.completeness,
      quality:      rawResponse.quality,
      accuracy:     rawResponse.accuracy,
      onTime:       rawResponse.onTime,
    };

    const result: EvaluationResult = {
      approved,
      score: weightedScore,
      reasoning: rawResponse.reasoning,
      criteria,
      swapId,
      timestamp: new Date().toISOString(),
    };

    console.log(
      `${new Date().toISOString()} [ArbitratorAgent] [${swapId.slice(0, 8)}…] ` +
      `Verdict: ${approved ? "APPROVE" : "REJECT"} ` +
      `score=${weightedScore}/100 (threshold=${this.approvalThreshold}) — ` +
      `${rawResponse.reasoning.slice(0, 80)}${rawResponse.reasoning.length > 80 ? "…" : ""}`
    );

    // Store in history
    this.history.push(result);

    return result;
  }

  // ── executeDecision ────────────────────────────────────────────────────────

  /**
   * Act on an evaluation result by calling the coordinator.
   *
   * APPROVE → coordinator.settleSwap(swapId)  (reveals preimage on Lightning)
   * REJECT  → coordinator.refundSwap(swapId)  (cancels BTC, schedules ETH refund)
   *
   * If a PreimageVault was provided in config, the entry is deleted after
   * a successful APPROVE to minimise the time the encrypted preimage stays in memory.
   *
   * @param result      The EvaluationResult from evaluateDeliverable().
   * @param coordinator The active SwapCoordinator managing this swap.
   */
  async executeDecision(
    result: EvaluationResult,
    coordinator: SwapCoordinator
  ): Promise<void> {
    const decision: ArbitratorDecision = result.approved ? "APPROVE" : "REJECT";
    const ts = new Date().toISOString();

    console.log(
      `${ts} [ArbitratorAgent] [${result.swapId.slice(0, 8)}…] ` +
      `Executing decision: ${decision}`
    );

    if (decision === "APPROVE") {
      await coordinator.settleSwap(result.swapId);
      // Clean up vault entry after successful settlement
      if (this.vault?.has(result.swapId)) {
        this.vault.delete(result.swapId);
        console.log(
          `${new Date().toISOString()} [ArbitratorAgent] [${result.swapId.slice(0, 8)}…] ` +
          `Vault entry deleted after settlement`
        );
      }
    } else {
      await coordinator.refundSwap(
        result.swapId,
        `Arbitrator REJECTED: score=${result.score}/100 (threshold=${this.approvalThreshold}). ` +
        result.reasoning
      );
    }
  }

  // ── getEvaluationHistory ───────────────────────────────────────────────────

  /**
   * Returns a shallow copy of all EvaluationResults produced by this agent
   * since it was instantiated, in chronological order.
   */
  getEvaluationHistory(): EvaluationResult[] {
    return [...this.history];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Call the LLM and parse the structured evaluation response.
   * Retries once on JSON parse failure or Zod validation failure.
   */
  private async _callWithRetry(
    taskDescription: string,
    deliverable: string,
    attempt = 0
  ): Promise<EvaluationResponse> {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: EVALUATION_PROMPT(taskDescription, deliverable),
      },
    ];

    return this._parseResponse(messages, taskDescription, deliverable, attempt);
  }

  private async _parseResponse(
    messages: Anthropic.MessageParam[],
    taskDescription: string,
    deliverable: string,
    attempt: number
  ): Promise<EvaluationResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: ARBITRATOR_SYSTEM_PROMPT,
      messages,
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("ArbitratorAgent: LLM returned no text content block");
    }

    // Strip markdown fences
    const raw = block.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    // JSON parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (attempt >= 1) {
        throw new Error(
          `ArbitratorAgent: JSON parse failed after retry.\nRaw:\n${raw}`
        );
      }
      return this._parseResponse(
        [
          ...messages,
          { role: "assistant" as const, content: block.text },
          {
            role: "user" as const,
            content:
              "Your last response was not valid JSON. " +
              "Return ONLY a raw JSON object — no markdown, no prose. " +
              "Start with `{` and end with `}`.",
          },
        ],
        taskDescription,
        deliverable,
        attempt + 1
      );
    }

    // Zod validation
    const result = EvaluationResponseSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }

    if (attempt >= 1) {
      throw new Error(
        `ArbitratorAgent: Zod validation failed after retry.\n` +
        `Error: ${result.error.message}\nParsed: ${JSON.stringify(parsed)}`
      );
    }

    const validationSummary = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");

    return this._parseResponse(
      [
        ...messages,
        { role: "assistant" as const, content: block.text },
        {
          role: "user" as const,
          content:
            "Your JSON did not match the required schema. Fix these errors:\n\n" +
            validationSummary +
            "\n\nRespond with ONLY the corrected JSON object.",
        },
      ],
      taskDescription,
      deliverable,
      attempt + 1
    );
  }
}
