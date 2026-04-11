/**
 * packages/agents/src/negotiationSchema.ts
 *
 * Zod schema for the NegotiationMessage exchanged by BuyerAgent and SellerAgent,
 * plus the shared LLM caller that validates and retries on bad JSON.
 */

import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

// ── Schema ─────────────────────────────���──────────────────────────────────────

export const NegotiationMessageSchema = z.object({
  /**
   * Protocol verb:
   *   PROPOSE — initial offer from buyer
   *   COUNTER — modified terms from either party
   *   ACCEPT  — unconditional agreement to the last stated terms
   *   REJECT  — hard no; negotiation ends immediately
   */
  messageType: z.enum(["PROPOSE", "COUNTER", "ACCEPT", "REJECT"]),

  /** Human-readable description of the task being purchased. */
  taskDescription: z.string().min(1, "taskDescription must not be empty"),

  /** Buyer's BTC offer in satoshis (positive integer). */
  btcAmountSats: z
    .number()
    .int("btcAmountSats must be an integer")
    .positive("btcAmountSats must be positive"),

  /**
   * Seller's required ETH payment in wei, as a decimal integer string.
   * Stored as a string to avoid JS precision loss on large wei values.
   */
  ethAmountWei: z
    .string()
    .regex(/^\d+$/, "ethAmountWei must be a non-negative decimal integer string"),

  /** 1-2 sentence explanation of this message's position. */
  reasoning: z.string().min(1, "reasoning must not be empty"),

  /** Which negotiation round this message belongs to (1–4). */
  round: z.number().int().min(1).max(4),
});

export type NegotiationMessage = z.infer<typeof NegotiationMessageSchema>;

// ── Schema description for LLM prompts ──────────────────────────────���────────

export const SCHEMA_DESCRIPTION = `
{
  "messageType": "PROPOSE" | "COUNTER" | "ACCEPT" | "REJECT",
  "taskDescription": "<string — the task being negotiated>",
  "btcAmountSats": <positive integer — BTC amount in satoshis>,
  "ethAmountWei": "<decimal integer string — ETH amount in wei, e.g. \\"1000000000000000000\\" for 1 ETH>",
  "reasoning": "<1-2 sentence explanation of your position>",
  "round": <integer 1-4>
}`.trim();

// ── Safe parser ──────────────────────────���───────────────────────────────���────

/**
 * Parse and validate a raw value against NegotiationMessageSchema.
 * Throws a ZodError with a descriptive message on failure.
 */
export function parseNegotiationMessage(raw: unknown): NegotiationMessage {
  return NegotiationMessageSchema.parse(raw);
}

// ── LLM caller with parse-and-validate retry ──────────────────────────────────

/**
 * Call Claude and parse + validate the response as a NegotiationMessage.
 *
 * Retry strategy (one automatic retry):
 *   - If JSON.parse fails → retry with a "raw JSON only" correction prompt
 *   - If Zod validation fails → retry with the exact schema + the validation error
 *
 * @param attempt  Internal retry counter — callers should not set this.
 */
export async function callNegotiationLLM(params: {
  client: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  attempt?: number;
}): Promise<NegotiationMessage> {
  const { client, model, system, messages, attempt = 0 } = params;

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system,
    messages,
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("callNegotiationLLM: LLM returned no text content block");
  }

  // Strip markdown fences if the model wrapped the JSON anyway
  const raw = block.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  // ── Step 1: JSON parse ──────────���────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (attempt >= 1) {
      throw new Error(
        `callNegotiationLLM: JSON parse failed after retry.\nRaw output:\n${raw}`
      );
    }
    return callNegotiationLLM({
      client,
      model,
      system,
      messages: [
        ...messages,
        { role: "assistant" as const, content: block.text },
        {
          role: "user" as const,
          content:
            "Your last response was not valid JSON. " +
            "Return ONLY a raw JSON object — no markdown fences, no prose, no explanation. " +
            "Just the JSON object itself, starting with `{` and ending with `}`.",
        },
      ],
      attempt: attempt + 1,
    });
  }

  // ── Step 2: Zod validation ──────────────���───────────────────────��────────
  const result = NegotiationMessageSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }

  if (attempt >= 1) {
    throw new Error(
      `callNegotiationLLM: Zod validation failed after retry.\n` +
      `Error: ${result.error.message}\nParsed: ${JSON.stringify(parsed)}`
    );
  }

  const validationSummary = result.error.issues
    .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
    .join("\n");

  return callNegotiationLLM({
    client,
    model,
    system,
    messages: [
      ...messages,
      { role: "assistant" as const, content: block.text },
      {
        role: "user" as const,
        content:
          "Your JSON did not match the required schema. Fix the following errors and respond again:\n\n" +
          validationSummary +
          "\n\nRequired schema:\n" +
          SCHEMA_DESCRIPTION +
          "\n\nRespond with ONLY the corrected JSON object.",
      },
    ],
    attempt: attempt + 1,
  });
}
