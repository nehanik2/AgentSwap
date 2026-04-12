# AgentSwap

**Trustless cross-chain escrow for autonomous AI agents — Bitcoin Lightning × Ethereum, zero human signatures required.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built at MIT Bitcoin Hackathon 2026](https://img.shields.io/badge/MIT%20Bitcoin%20Hackathon-2026-orange.svg)]()

> 🎥 **[Demo Video](#)** ← _link added after submission_

---

## The Problem

AI agents are becoming economic actors — they browse the web, write code, translate documents, and make real-time decisions — but they are financially trapped. A buyer agent holding BTC cannot pay a seller agent that only accepts ETH without routing through a centralized exchange, a custodian, or a human operator who signs every transaction. There is no trustless, autonomous payment rail for cross-currency agent-to-agent commerce. AgentSwap builds that rail.

---

## How It Works

1. **Negotiate** — A buyer AI and a seller AI exchange structured JSON proposals over multiple rounds until they agree on price (BTC sats ↔ ETH wei), timelocks, and task specification. No human writes the contract.

2. **Lock** — The buyer locks ETH into a `HashedTimelockETH` smart contract on Ethereum. The seller creates a Lightning HODL invoice on Bitcoin. Both locks reference the same cryptographic hash. Neither party can access the other's funds yet.

3. **Deliver** — The seller AI produces the deliverable (translation, code review, document, or any text-based work) and submits it to the protocol.

4. **Arbitrate** — A third, fully independent Claude instance reads the original task specification and the deliverable side by side. It scores the work across four weighted criteria (completeness, quality, accuracy, timeliness) and issues a binding verdict: APPROVE (score ≥ 70/100) or REJECT.

5. **Settle or Refund** — If approved, the arbitrator releases the 32-byte preimage. The seller uses it to claim BTC by settling the Lightning invoice, and claim ETH from the smart contract. The same secret unlocks both chains simultaneously. If rejected, the preimage is never released; both chains refund to the buyer automatically after their timelocks expire.

---

## The Atomic Guarantee

Atomicity comes from a single 32-byte secret — the **preimage** — generated randomly by the buyer before the swap begins.

- Its **SHA-256 hash** is embedded in the Lightning HODL invoice (BOLT spec standard).
- Its **keccak256 hash** is embedded in the Ethereum HTLC (cheapest EVM opcode).
- The preimage itself is held in an AES-256-GCM encrypted in-memory vault by the arbitrator until a verdict is issued.

This means:

| Scenario | Outcome |
|---|---|
| Arbitrator approves | Preimage released → seller claims BTC + ETH simultaneously |
| Arbitrator rejects | Preimage never released → both chains refund to buyer on timelock expiry |
| Arbitrator goes offline | Both timelocks expire → buyer recovers all funds, no action needed |
| Seller takes BTC without revealing preimage | Impossible — Lightning settlement requires the preimage on-chain |

The hash function difference between chains (SHA-256 on Lightning, keccak256 on Ethereum) is intentional. In a traditional atomic swap the same hash would enforce atomicity cryptographically without any intermediary. Here the AI arbitrator plays the role of the coordinator — it holds the preimage and releases it only after evaluating the deliverable. This is the design space we are exploring: extending trustless escrow to deliverables that cannot be verified by a smart contract alone.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Bitcoin** | Bitcoin Core (regtest), LND v0.18, HODL invoices (BOLT 2) |
| **Ethereum** | Solidity 0.8.24 HTLC contract, Hardhat, ethers.js v6, Ganache |
| **AI Agents** | Anthropic Claude (`claude-sonnet-4-6`), structured JSON via `messages.create` |
| **Backend** | Node.js, Express, Server-Sent Events (SSE), TypeScript |
| **Frontend** | Next.js 14 App Router, React 18, Tailwind CSS |
| **Crypto** | SHA-256 (Lightning), keccak256 (Ethereum), AES-256-GCM (preimage vault) |
| **Infrastructure** | Docker Compose (bitcoind + 2× LND + Ganache), pnpm workspaces |

---

## Running Locally

### Prerequisites

- Docker Desktop, Node.js ≥ 20, pnpm ≥ 9
- An Anthropic API key (`sk-ant-…`)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/your-org/agentswap
cd agentswap
pnpm install

# 2. Configure
cp .env.example .env
# Set ANTHROPIC_API_KEY=sk-ant-... in .env

# 3. Start blockchain stack + deploy + fund wallets
pnpm docker:up
bash scripts/fund-wallets.sh
pnpm --filter @agentswap/ethereum deploy:local
# Contract address is written to .env.local automatically

# 4. Start the API server (port 3001)
pnpm --filter @agentswap/server dev

# 5. Start the dashboard (port 3000)
pnpm --filter @agentswap/dashboard dev
```

### One-command launcher

```bash
bash scripts/start-demo.sh
```

Handles everything above (Docker, mining, channel opening, contract deploy, dashboard) in 2–4 minutes.

### Run the demo

Open `http://localhost:3000`. Use the **Demo Controller** at the bottom of the center column:

| Scenario | Deliverable | Expected outcome |
|---|---|---|
| Translation Task | Quality translation | SETTLED |
| Code Review | Thorough review | SETTLED |
| Bad Delivery | Garbage text | REFUNDED |

Or type a custom task in the header selector and click **▶ Start Demo** for a fully LLM-generated run.

---

## Security Model

### Asymmetric timelocks

The Ethereum HTLC timelock is always set longer than the Bitcoin Lightning invoice expiry:

```
ETH timelock  >  BTC invoice expiry
```

If the seller settles the Lightning invoice (revealing the preimage on the Bitcoin blockchain) but the Ethereum claim transaction stalls, the buyer can observe the preimage on-chain and claim the ETH themselves within the remaining ETH timelock window. This ordering ensures the buyer always has a recovery path.

### Preimage vault

The 32-byte preimage is generated using `crypto.randomBytes(32)` and stored in an AES-256-GCM encrypted in-memory vault (`PreimageVault`). It is never written to disk or logged in plaintext. It is deleted from the vault after the swap reaches a terminal state (SETTLED or REFUNDED). The vault encryption key is derived at startup from the server's runtime entropy.

### What the arbitrator cannot do

- **Cannot steal funds** — it holds no private keys for either chain. It only holds the preimage.
- **Cannot double-spend** — each swap generates a fresh random preimage; there is no replay surface.
- **Cannot act silently** — every evaluation score and reasoning string is broadcast to all SSE clients in real time and logged server-side.

### If the arbitrator goes offline

Both chains refund to their respective senders after timelock expiry. No manual intervention is required. The seller loses only the time spent on the deliverable. This is the core HTLC guarantee: no single party (including the arbitrator) can permanently confiscate funds.

---

## Roadmap

1. **Mainnet** — Replace regtest/Ganache with mainnet Bitcoin Lightning and Ethereum mainnet (or an L2). Add formal contract audit and dispute-appeal flow.

2. **Multi-chain** — Extend the same preimage-based protocol to Solana (Anchor program), Cosmos (IBC), and Starknet. Any chain with hash-locked contracts can participate without protocol changes.

3. **Agent SDK** — Publish `@agentswap/sdk` — a single-import library giving any AI agent framework (LangChain, AutoGen, custom) a `pay(task, budget)` and `earn(capabilities, minRate)` interface. The agent never touches HTLCs or timelocks directly.

---

## License

MIT — see [LICENSE](LICENSE).

---

*Built at MIT Bitcoin Hackathon 2026 · Theme: Freedom for All*
