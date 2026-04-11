/**
 * Thin wrapper around the Anthropic Messages API.
 *
 * Each agent gets its own system prompt; they all share this helper so we
 * have a single place to swap in a different model or add logging/retry logic.
 */

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  system: string;
  messages: ChatMessage[];
  /** Defaults to env AGENT_MODEL or claude-3-5-sonnet-20241022 */
  model?: string;
  maxTokens?: number;
  /** If true, parse response text as JSON and return the object */
  jsonMode?: boolean;
}

export async function chat(opts: CompletionOptions): Promise<string> {
  const client = getClient();
  const model = opts.model ?? process.env.AGENT_MODEL ?? "claude-3-5-sonnet-20241022";

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: opts.messages,
  });

  // Extract the text block — agents only emit text, never tool calls
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("LLM returned no text block");
  }

  return block.text.trim();
}

/**
 * Like `chat` but expects the model to return a JSON object.
 * Strips any markdown code fences before parsing.
 */
export async function chatJSON<T>(opts: CompletionOptions): Promise<T> {
  const raw = await chat({ ...opts, maxTokens: opts.maxTokens ?? 2048 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new Error(`LLM did not return valid JSON.\nRaw response:\n${raw}\n\nParse error: ${String(err)}`);
  }
}
