# ⚡ AgentSwap

> **Cross-chain atomic swap escrow where AI agents negotiate contracts, lock funds via HTLCs on Bitcoin Lightning and Ethereum simultaneously, and settle trustlessly — zero human involvement.**

```
Buyer Agent ──negotiate──► Seller Agent
     │                          │
     │◄─── Arbitrator Agent ────│
     │                          │
  BTC HTLC (LND)         ETH HTLC (Solidity)
     └────────── atomic ────────┘
```

---

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Running the Demo](#running-the-demo)
6. [Health Checks — Verifying Everything Works](#health-checks)
7. [Package Overview](#package-overview)
8. [How the Atomic Swap Works](#how-the-atomic-swap-works)
9. [Troubleshooting](#troubleshooting)

---

## Architecture

```
agentswap/
├── packages/
│   ├── shared/          # TypeScript types (SwapProposal, SwapState, HTLCReceipt…)
│   ├── lightning/       # LND REST client + hold-invoice HTLC helpers
│   ├── ethereum/        # HashedTimelockETH.sol + ethers v6 client + Hardhat config
│   ├── agents/          # Buyer / Seller / Arbitrator AI agents + Orchestrator
│   └── dashboard/       # Next.js 14 live demo UI with SSE real-time feed
├── scripts/
│   ├── start-demo.sh    # One-command launcher
│   └── fund-wallets.sh  # Re-fund test wallets
├── docker-compose.yml   # bitcoind + buyer-lnd + seller-lnd + ganache
└── .env.example
```

**Stack:**
| Layer | Technology |
|---|---|
| Bitcoin | bitcoind regtest + LND v0.18 |
| Ethereum | Ganache v7 (local) / Sepolia (testnet) |
| Smart Contract | Solidity 0.8.24, Hardhat |
| Chain Client | ethers.js v6, LND REST API |
| AI Agents | Anthropic Claude (claude-3-5-sonnet) |
| Dashboard | Next.js 14 App Router, Tailwind CSS, SSE |
| Monorepo | pnpm workspaces |

---

## Prerequisites

Install the following before proceeding:

| Tool | Minimum Version | Check |
|---|---|---|
| **Node.js** | 20.x LTS | `node --version` |
| **pnpm** | 9.x | `pnpm --version` |
| **Docker Desktop** | 24.x | `docker --version` |
| **docker compose** | v2 (plugin) | `docker compose version` |
| **curl** | any | `curl --version` |
| **jq** | any | `jq --version` |

Install pnpm if missing:
```bash
npm install -g pnpm@9
```

---

## Installation

### Step 1 — Clone the repository

```bash
git clone https://github.com/yourname/agentswap.git
cd agentswap
```

### Step 2 — Install workspace dependencies

```bash
pnpm install
```

Expected output (last few lines):
```
Done in 42s
```

### Step 3 — Configure environment variables

```bash
cp .env.example .env
```

Open `.env` in your editor and set **at minimum**:

```bash
# The only value you MUST change:
ANTHROPIC_API_KEY=sk-ant-api03-...your-key-here...

# Everything else has working defaults for local regtest.
```

> **Where to get an API key:** https://console.anthropic.com → API Keys → Create Key

All other values (LND URLs, Ethereum keys, contract address) are auto-populated by `start-demo.sh`.

---

## Running the Demo

### Option A — One-command launcher (recommended)

```bash
bash scripts/start-demo.sh
```

This script will:
1. ✅ Check prerequisites
2. 📦 Install dependencies (if needed)
3. 🐳 Start Docker services (bitcoind, buyer-lnd, seller-lnd, ganache)
4. ⛏️  Mine 150 regtest blocks (segwit activation + coinbase maturity)
5. ⏳ Wait for both LND nodes to sync to chain tip
6. 💰 Fund both LND wallets (2 BTC each)
7. ⚡ Open a 1M-sat Lightning channel between buyer and seller
8. 📜 Compile and deploy `HashedTimelockETH.sol` to Ganache
9. 💾 Write runtime addresses to `.env.local`
10. 🌐 Start the Next.js dashboard at **http://localhost:3000**

**Expected total time: 2–4 minutes** (mostly waiting for LND sync and block confirmations).

### Option B — Manual step-by-step

```bash
# 1. Start Docker services only
docker compose up -d

# 2. Install and build packages
pnpm install
pnpm build

# 3. Fund wallets
bash scripts/fund-wallets.sh

# 4. Deploy Ethereum contract
cd packages/ethereum
pnpm exec hardhat compile
pnpm exec hardhat run scripts/deploy.ts --network localhost
cd ../..

# 5. Start dashboard
cd packages/dashboard
pnpm dev
```

---

## Health Checks

Use these commands to verify each component is working correctly.

### 🐳 Docker containers

```bash
docker compose ps
```

**Expected output — all containers should show `running` or `healthy`:**
```
NAME                     STATUS
agentswap-bitcoind       running (healthy)
agentswap-buyer-lnd      running (healthy)
agentswap-seller-lnd     running (healthy)
agentswap-ganache        running (healthy)
```

If a container shows `Exit` or `unhealthy`:
```bash
# View logs for the failing container:
docker compose logs bitcoind
docker compose logs buyer-lnd
docker compose logs seller-lnd
docker compose logs ganache
```

---

### ₿ Bitcoin Core (regtest)

```bash
docker exec agentswap-bitcoind bitcoin-cli \
  -regtest -rpcuser=agentswap -rpcpassword=agentswap \
  getblockchaininfo
```

**Expected:** JSON with `"chain": "regtest"` and `"blocks"` ≥ 150.

```bash
# Check wallet balance (should be > 0 after funding):
docker exec agentswap-bitcoind bitcoin-cli \
  -regtest -rpcuser=agentswap -rpcpassword=agentswap \
  getbalance
```

---

### ⚡ LND Nodes

**Buyer LND:**
```bash
docker exec agentswap-buyer-lnd lncli \
  --network=regtest --no-macaroons --rpcserver=localhost:10009 \
  getinfo
```

**Expected:** JSON with `"alias": "buyer-lnd"`, `"synced_to_chain": true`.

**Seller LND:**
```bash
docker exec agentswap-seller-lnd lncli \
  --network=regtest --no-macaroons --rpcserver=localhost:10009 \
  getinfo
```

**Check wallet balances:**
```bash
# Buyer balance (should be ~2 BTC = 200,000,000 sats after funding):
docker exec agentswap-buyer-lnd lncli \
  --network=regtest --no-macaroons --rpcserver=localhost:10009 \
  walletbalance

# Seller balance:
docker exec agentswap-seller-lnd lncli \
  --network=regtest --no-macaroons --rpcserver=localhost:10009 \
  walletbalance
```

**Check Lightning channel:**
```bash
docker exec agentswap-buyer-lnd lncli \
  --network=regtest --no-macaroons --rpcserver=localhost:10009 \
  listchannels
```

**Expected:** At least one channel with `"active": true`, `"capacity": "1000000"`.

**LND REST API (used by the TypeScript client):**
```bash
# Buyer REST — note: self-signed cert, use -k
curl -k https://localhost:8080/v1/getinfo | jq .alias

# Seller REST:
curl -k https://localhost:8081/v1/getinfo | jq .alias
```

---

### 🔷 Ganache (Ethereum)

```bash
# Check chain ID (should be 1337):
curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  | jq -r '.result'
# Expected: 0x539 (= 1337 in hex)

# Check account balance (Account[0] should have 1000 ETH):
curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","latest"],"id":1}' \
  | jq -r '.result'
# Expected: 0x3635c9adc5dea00000 (1000 ETH in wei, hex)
```

**Check deployed contract:**
```bash
# Get contract address from .env.local:
CONTRACT=$(grep ETH_HTLC_CONTRACT_ADDRESS .env.local | cut -d= -f2)

# Check it has code deployed (should NOT return 0x):
curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"${CONTRACT}\",\"latest\"],\"id\":1}" \
  | jq -r '.result' | cut -c1-20
# Expected: 0x608060405234801... (compiled EVM bytecode)
```

---

### 🤖 AI Agents (Anthropic API)

```bash
# Quick connectivity test:
curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  | jq '.data[0].id'
# Expected: "claude-..." (some model name)
```

---

### 🌐 Dashboard (Next.js)

```bash
# Check it's responding:
curl -s http://localhost:3000 | grep -o "AgentSwap"
# Expected: AgentSwap

# Check the swap API:
curl -s -X POST http://localhost:3000/api/swap \
  -H "Content-Type: application/json" \
  -d '{"taskDescription":"Write one sentence about Bitcoin."}' \
  | jq .
# Expected: {"swapId":"<uuid>"}
```

---

### 🏃 Full End-to-End Smoke Test

Run this to verify the complete pipeline:

```bash
# Start a swap and stream events for 60 seconds:
SWAP_ID=$(curl -sf -X POST http://localhost:3000/api/swap \
  -H "Content-Type: application/json" \
  -d '{"taskDescription":"Write a haiku about trustless finance."}' \
  | jq -r .swapId)

echo "Swap ID: ${SWAP_ID}"
timeout 120 curl -sN "http://localhost:3000/api/swap/stream?swapId=${SWAP_ID}"
```

You should see a stream of SSE events like:
```
event: stateChange
data: {"swapId":"...","state":"NEGOTIATING"}

event: message
data: {"role":"buyer","content":"I'd like to hire you for...","..."}

event: message
data: {"role":"seller","content":"Deal! ..."}

event: stateChange
data: {"swapId":"...","state":"LOCKED"}
...
event: complete
data: {"proposal":{...},"state":"SETTLED",...}
```

---

## Package Overview

| Package | Description | Key Files |
|---|---|---|
| `@agentswap/shared` | TypeScript types — the contract between all packages | `types.ts` |
| `@agentswap/lightning` | LND REST client; hold invoice creation, payment, settlement | `src/client.ts`, `src/htlc.ts` |
| `@agentswap/ethereum` | Solidity HTLC + ethers.js client + Hardhat deploy | `contracts/HashedTimelockETH.sol`, `src/client.ts` |
| `@agentswap/agents` | Buyer / Seller / Arbitrator agents + Orchestrator | `src/orchestrator.ts`, `src/buyer.ts`, `src/seller.ts`, `src/arbitrator.ts` |
| `@agentswap/dashboard` | Next.js UI with SSE real-time event feed | `app/page.tsx`, `app/api/swap/` |

---

## How the Atomic Swap Works

```
1. NEGOTIATING
   Buyer agent  ──proposal──►  Seller agent
   (LLM decides price, timelock, counter-offers)

2. LOCKED
   Seller  ──lock ETH HTLC──►  Smart Contract (Ganache)
   Seller  ──hold invoice───►  Seller LND node
   Buyer   ──pay invoice────►  Buyer LND node  (funds in-flight)
   Both sides now committed — neither can exit without losing funds

3. EVALUATING
   Seller  ──deliverable──►  Arbitrator agent
   (LLM scores quality 0–100, threshold = 70)

4. APPROVED
   Arbitrator releases preimage to Orchestrator

5. SETTLED
   Seller  ──settle(preimage)──►  Seller LND  → BTC claimed ⚡
   Buyer   ──claim(preimage)───►  ETH Contract → ETH claimed 🔷

   OR on timeout/rejection:
   Seller cancels hold invoice → Buyer's BTC returned
   Sender calls refund() on ETH contract → ETH returned
```

**Why two different hash functions?**
- Lightning HTLC uses **SHA-256** (the BOLT spec standard).
- Ethereum HTLC uses **keccak256** (cheapest EVM opcode).
- In a traditional atomic swap these would be the same hash, enforcing atomicity cryptographically.
- In AgentSwap the **arbitrator agent** plays the role of the trusted coordinator — it holds the preimage and releases it only after approving the deliverable. This is the "AI-mediated" innovation.

---

## Troubleshooting

### LND not syncing to chain tip

```bash
# Mine more blocks to trigger sync:
docker exec agentswap-bitcoind bitcoin-cli \
  -regtest -rpcuser=agentswap -rpcpassword=agentswap \
  generatetoaddress 10 $(docker exec agentswap-bitcoind bitcoin-cli \
    -regtest -rpcuser=agentswap -rpcpassword=agentswap getnewaddress)
```

### Channel not active after opening

```bash
# Mine confirmation blocks:
docker exec agentswap-bitcoind bitcoin-cli \
  -regtest -rpcuser=agentswap -rpcpassword=agentswap \
  generatetoaddress 6 $(docker exec agentswap-bitcoind bitcoin-cli \
    -regtest -rpcuser=agentswap -rpcpassword=agentswap getnewaddress)
```

### Ganache resets on restart

Ganache is stateless — restart wipes state. Re-deploy the contract:
```bash
cd packages/ethereum && pnpm exec hardhat run scripts/deploy.ts --network localhost
```

### "ANTHROPIC_API_KEY is not set"

Ensure your `.env` file exists and contains the key:
```bash
grep ANTHROPIC_API_KEY .env
```

### pnpm workspace not resolving packages

```bash
pnpm install --force
pnpm build
```

### Reset everything and start fresh

```bash
docker compose down -v   # wipe all Docker volumes
rm -f .env.local
bash scripts/start-demo.sh
```

---

## License

MIT — build freely, swap trustlessly.
