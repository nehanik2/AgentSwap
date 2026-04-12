/**
 * vitest.config.ts
 *
 * Vitest configuration for AgentSwap integration tests.
 *
 * All integration tests are in tests/integration/ and run against a LIVE
 * local environment (Docker + Express server + Ganache).  They are NOT
 * unit tests — never mock the blockchain or LLM.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests hit real services — generous timeouts
    testTimeout: 180_000,   // 3 min per test
    hookTimeout:  30_000,   // 30 s for before/after hooks

    // Never run integration tests in parallel — they share Lightning channels
    // and the same Ganache state.  Sequential execution avoids nonce conflicts
    // and channel-liquidity races.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 1,
        minForks: 1,
      },
    },

    // Only run files under tests/integration/
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules", "**/dist/**"],

    // Load .env + .env.local so CONTRACT_ADDRESS etc. are available
    env: {
      NODE_TLS_REJECT_UNAUTHORIZED: "0", // LND uses self-signed TLS
    },

    // Verbose reporter so CI logs show each check as it passes
    reporter: "verbose",

    // Retry flaky network tests once before marking as failed
    retry: 1,
  },

  resolve: {
    // Support workspace packages' TypeScript source directly
    conditions: ["import", "node"],
  },
});
