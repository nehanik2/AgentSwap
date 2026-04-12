/**
 * packages/agents/src/demoScenarios.ts
 *
 * Pre-defined demo scenarios for controlled presentations.
 *
 * Each scenario carries a fixed deliverable so judges see a deterministic
 * result rather than an unpredictable LLM generation.  Good deliverables
 * are crafted to score >= 80/100; bad ones score <= 40/100 so the refund
 * path fires reliably.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DemoScenario {
  /** Stable machine-readable identifier — used as the route param. */
  id: string;
  /** Short display name for the controller button. */
  name: string;
  /** One-sentence explanation shown in the UI. */
  description: string;
  /** Full natural-language task spec passed to the buyer negotiation agent. */
  taskDescription: string;
  /** Buyer's maximum BTC budget in satoshis. */
  buyerBudgetSats: number;
  /** Seller's expected ETH payment as a wei string (for informational display). */
  sellerExpectedEthWei: string;
  /**
   * Pre-written deliverable the demo injects directly (bypassing the LLM
   * generation step so the demo is fast and deterministic).
   */
  deliverable: string;
  /** Whether the deliverable is expected to pass arbitration. */
  deliverableQuality: "good" | "bad";
  /** Which terminal state the swap should reach after evaluation. */
  expectedOutcome: "SETTLED" | "REFUNDED";
}

// ── DEMO_SCENARIOS ────────────────────────────────────────────────────────────

export const DEMO_SCENARIOS: DemoScenario[] = [
  // ── Scenario 1: Translation Task (happy path) ────────────────────────────

  {
    id:          "translation-task",
    name:        "Translation Task",
    description: "English→Spanish paragraph. Seller delivers quality work. Swap settles.",
    taskDescription:
      'Translate the following paragraph from English to Spanish, maintaining the '
      + 'original tone and technical vocabulary: "The future of finance is trustless. '
      + 'Atomic swaps enable two parties to exchange assets across different blockchains '
      + 'without ever needing to trust each other or a third party. The cryptographic '
      + 'hash lock ensures both transactions settle simultaneously or neither does."',
    buyerBudgetSats:     50_000,
    sellerExpectedEthWei: "20000000000000000",  // 0.02 ETH
    deliverable:
      "El futuro de las finanzas es sin confianza. Los intercambios atómicos permiten "
      + "a dos partes intercambiar activos a través de diferentes blockchains sin "
      + "necesidad de confiar el uno en el otro ni en un tercero. El bloqueo hash "
      + "criptográfico garantiza que ambas transacciones se liquiden simultáneamente "
      + "o ninguna de las dos lo haga.",
    deliverableQuality: "good",
    expectedOutcome:    "SETTLED",
  },

  // ── Scenario 2: Code Review Task (happy path) ────────────────────────────

  {
    id:          "code-review-task",
    name:        "Code Review",
    description: "Python SQL injection bug. Seller produces detailed review. Swap settles.",
    taskDescription:
      "Review the following Python function and provide: (1) a list of all bugs and "
      + "security issues with severity ratings, (2) a line-by-line explanation of each "
      + "problem, (3) a corrected version of the function.\n\n"
      + "```python\n"
      + "def get_user(user_id):\n"
      + '    query = "SELECT * FROM users WHERE id = " + user_id\n'
      + "    result = db.execute(query)\n"
      + "    return result[0]\n"
      + "```",
    buyerBudgetSats:     100_000,
    sellerExpectedEthWei: "50000000000000000", // 0.05 ETH
    deliverable:
      "## Code Review: get_user() Function\n\n"
      + "### Issues Found\n\n"
      + "**[CRITICAL] SQL Injection — Line 2**\n"
      + "String concatenation of `user_id` directly into the query allows an attacker "
      + 'to pass `user_id = "1 OR 1=1 --"` to dump all rows, or `"1; DROP TABLE users"` '
      + "to destroy data. Fix: use parameterised queries.\n\n"
      + "**[HIGH] Unhandled IndexError — Line 4**\n"
      + "`result[0]` raises `IndexError` if the query returns zero rows (user not found). "
      + "The caller has no way to distinguish 'not found' from a runtime crash.\n\n"
      + "**[MEDIUM] SELECT * over-fetches — Line 2**\n"
      + "Selecting all columns wastes bandwidth and exposes sensitive fields "
      + "(e.g. password hashes) to callers that don't need them.\n\n"
      + "**[LOW] Missing type annotation — Line 1**\n"
      + "`user_id` has no type hint; callers can accidentally pass a non-string.\n\n"
      + "### Corrected Version\n\n"
      + "```python\n"
      + "def get_user(user_id: int) -> dict | None:\n"
      + '    """Return user row by ID, or None if not found."""\n'
      + '    query = "SELECT id, username, email FROM users WHERE id = ?"\n'
      + "    result = db.execute(query, (user_id,))\n"
      + "    row = result.fetchone()\n"
      + "    return dict(row) if row else None\n"
      + "```\n\n"
      + "### Summary\n"
      + "The original function has a critical SQL injection vulnerability that must be "
      + "patched immediately before production deployment. The corrected version uses "
      + "parameterised queries, handles missing rows gracefully, narrows the SELECT "
      + "to required columns, and adds type annotations for clarity.",
    deliverableQuality: "good",
    expectedOutcome:    "SETTLED",
  },

  // ── Scenario 3: Bad Delivery (refund path) ───────────────────────────────

  {
    id:          "bad-delivery-demo",
    name:        "Bad Delivery Demo",
    description: "Seller submits gibberish. Arbitrator rejects. Shows the full refund path.",
    taskDescription:
      'Translate the following sentence from English to French: '
      + '"Decentralised systems require no trusted intermediary."',
    buyerBudgetSats:     50_000,
    sellerExpectedEthWei: "20000000000000000", // 0.02 ETH
    deliverable:
      "asdfgh jkl qwerty uiop zxcvbnm. Lorem ipsum dolor sit amet consectetur. "
      + "blockchain crypto DeFi NFT metaverse Web3 hodl moon lambo rekt. "
      + "This is definitely a translation I promise. "
      + "words words words more words random text filler content placeholder. "
      + "1234567890 !@#$%^&*(). The quick brown fox. Not a translation at all.",
    deliverableQuality: "bad",
    expectedOutcome:    "REFUNDED",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getScenario(id: string): DemoScenario | undefined {
  return DEMO_SCENARIOS.find((s) => s.id === id);
}
