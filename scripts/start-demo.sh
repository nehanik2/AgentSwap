#!/usr/bin/env bash
# =============================================================================
# AgentSwap — start-demo.sh
# One-command local demo launcher.
#
# What this script does (in order):
#   1. Validates required env vars and tooling
#   2. Spins up Docker services (bitcoind, buyer-lnd, seller-lnd, ganache)
#   3. Mines initial blocks so LND wallets can fund themselves
#   4. Waits for both LND nodes to fully sync
#   5. Funds the LND wallets via bitcoind
#   6. Opens a 1M-sat Lightning channel from buyer → seller
#   7. Deploys the Ethereum HTLC contract to Ganache
#   8. Writes runtime addresses to .env.local
#   9. Starts the Next.js dashboard
#
# Usage:
#   bash scripts/start-demo.sh [--skip-docker] [--skip-channel]
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[demo]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
err()  { echo -e "${RED}[✗]${RESET} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Flags ─────────────────────────────────────────────────────────────────────
SKIP_DOCKER=false
SKIP_CHANNEL=false
for arg in "$@"; do
  case $arg in
    --skip-docker)  SKIP_DOCKER=true ;;
    --skip-channel) SKIP_CHANNEL=true ;;
  esac
done

# ── 0. Preflight checks ───────────────────────────────────────────────────────
log "Running preflight checks…"

for cmd in docker pnpm node curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    err "'$cmd' is not installed. Please install it and re-run."
  fi
done

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
REQUIRED_MAJOR=20
ACTUAL_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if (( ACTUAL_MAJOR < REQUIRED_MAJOR )); then
  err "Node.js ≥ ${REQUIRED_MAJOR} required (found ${NODE_VER})"
fi

# Load base .env
if [[ -f "${ROOT}/.env" ]]; then
  set -a; source "${ROOT}/.env"; set +a
  ok "Loaded .env"
else
  warn ".env not found — copying from .env.example"
  cp "${ROOT}/.env.example" "${ROOT}/.env"
  err "Please fill in .env (at minimum ANTHROPIC_API_KEY) then re-run."
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  err "ANTHROPIC_API_KEY is not set in .env"
fi

ok "Preflight passed"

# ── 1. Install dependencies ───────────────────────────────────────────────────
log "Installing workspace dependencies…"
cd "${ROOT}"
pnpm install --frozen-lockfile 2>&1 | tail -5
ok "Dependencies installed"

# ── 2. Docker services ────────────────────────────────────────────────────────
if [[ "$SKIP_DOCKER" == "false" ]]; then
  log "Starting Docker services…"
  docker compose -f "${ROOT}/docker-compose.yml" up -d --remove-orphans
  ok "Docker services started"
else
  warn "--skip-docker passed; assuming services are already running."
fi

# ── 3. Helper: Bitcoin RPC ────────────────────────────────────────────────────
BTC_RPC_USER="${BITCOIN_RPC_USER:-agentswap}"
BTC_RPC_PASS="${BITCOIN_RPC_PASS:-agentswap}"
BTC_RPC="http://${BTC_RPC_USER}:${BTC_RPC_PASS}@127.0.0.1:18443"

bitcoin_cli() {
  # Runs bitcoin-cli inside the bitcoind container
  docker exec agentswap-bitcoind bitcoin-cli \
    -regtest \
    -rpcuser="${BTC_RPC_USER}" \
    -rpcpassword="${BTC_RPC_PASS}" \
    "$@"
}

lncli_buyer() {
  docker exec agentswap-buyer-lnd lncli \
    --network=regtest --no-macaroons \
    --rpcserver=localhost:10009 "$@"
}

lncli_seller() {
  docker exec agentswap-seller-lnd lncli \
    --network=regtest --no-macaroons \
    --rpcserver=localhost:10009 "$@"
}

# ── 4. Wait for bitcoind ──────────────────────────────────────────────────────
log "Waiting for bitcoind to be ready…"
MAX_WAIT=60; WAITED=0
until bitcoin_cli getblockchaininfo &>/dev/null; do
  sleep 2; WAITED=$((WAITED + 2))
  [[ $WAITED -ge $MAX_WAIT ]] && err "bitcoind did not start within ${MAX_WAIT}s"
done
ok "bitcoind is ready (height=$(bitcoin_cli getblockcount))"

# ── 5. Mine initial blocks ────────────────────────────────────────────────────
BLOCK_HEIGHT=$(bitcoin_cli getblockcount)
if (( BLOCK_HEIGHT < 150 )); then
  log "Mining 150 blocks to activate segwit and mature coinbase…"
  # Use a throwaway address for the mining reward — we'll fund LND wallets separately
  MINE_ADDR=$(bitcoin_cli getnewaddress "" "bech32")
  bitcoin_cli generatetoaddress 150 "$MINE_ADDR" > /dev/null
  ok "Mined 150 blocks (height=$(bitcoin_cli getblockcount))"
else
  ok "Skipping initial mining — height already ${BLOCK_HEIGHT}"
fi

# ── 6. Wait for LND nodes ─────────────────────────────────────────────────────
wait_for_lnd() {
  local name="$1"
  local cli_fn="$2"
  local max=120; local waited=0
  log "Waiting for ${name} to sync…"
  until $cli_fn getinfo &>/dev/null 2>&1; do
    sleep 3; waited=$((waited + 3))
    [[ $waited -ge $max ]] && err "${name} did not start within ${max}s"
  done
  ok "${name} is ready ($(${cli_fn} getinfo 2>/dev/null | jq -r '.alias' 2>/dev/null || echo 'unknown'))"
}

wait_for_lnd "buyer-lnd"  lncli_buyer
wait_for_lnd "seller-lnd" lncli_seller

# ── 7. Fund LND wallets ───────────────────────────────────────────────────────
log "Funding LND wallets…"

BUYER_ADDR=$(lncli_buyer newaddress p2wkh 2>/dev/null | jq -r '.address')
SELLER_ADDR=$(lncli_seller newaddress p2wkh 2>/dev/null | jq -r '.address')

if [[ -z "$BUYER_ADDR" || -z "$SELLER_ADDR" ]]; then
  err "Could not get LND wallet addresses. Check LND logs: docker compose logs buyer-lnd"
fi

log "Buyer  address: ${BUYER_ADDR}"
log "Seller address: ${SELLER_ADDR}"

# Send 2 BTC to each node
bitcoin_cli sendtoaddress "$BUYER_ADDR" 2 > /dev/null
bitcoin_cli sendtoaddress "$SELLER_ADDR" 2 > /dev/null

# Mine 6 blocks to confirm the funding transactions
MINE_ADDR=$(bitcoin_cli getnewaddress "" "bech32")
bitcoin_cli generatetoaddress 6 "$MINE_ADDR" > /dev/null
ok "Funded both LND wallets (2 BTC each, 6 confirmations)"

# Wait for LND to see the confirmed balance
sleep 5

# ── 8. Open Lightning channel ─────────────────────────────────────────────────
if [[ "$SKIP_CHANNEL" == "false" ]]; then
  # Check if a channel already exists
  EXISTING_CHANS=$(lncli_buyer listchannels 2>/dev/null | jq '.channels | length')
  if [[ "$EXISTING_CHANS" -gt 0 ]]; then
    warn "Channel already exists — skipping open. Use --skip-channel to suppress this check."
  else
    log "Opening 1M-sat Lightning channel: buyer → seller…"

    SELLER_PUBKEY=$(lncli_seller getinfo 2>/dev/null | jq -r '.identity_pubkey')
    if [[ -z "$SELLER_PUBKEY" ]]; then
      err "Could not get seller pubkey"
    fi
    log "Seller pubkey: ${SELLER_PUBKEY}"

    # Connect buyer → seller (P2P)
    lncli_buyer connect "${SELLER_PUBKEY}@agentswap-seller-lnd:9735" 2>/dev/null || true
    sleep 2

    # Open the channel
    # --push_amt: push 200k sats to seller so both sides have liquidity
    CHAN_RESULT=$(lncli_buyer openchannel \
      --node_key="${SELLER_PUBKEY}" \
      --local_amt=1000000 \
      --push_amt=200000 \
      --spend_unconfirmed 2>/dev/null)

    log "Channel open result: ${CHAN_RESULT}"

    # Mine 6 blocks to confirm the channel open transaction
    bitcoin_cli generatetoaddress 6 "$MINE_ADDR" > /dev/null
    sleep 5

    # Wait for the channel to become active
    MAX_WAIT=60; WAITED=0
    log "Waiting for channel to become active…"
    until [[ "$(lncli_buyer listchannels 2>/dev/null | jq '[.channels[] | select(.active == true)] | length')" -gt 0 ]]; do
      sleep 3; WAITED=$((WAITED + 3))
      # Keep mining to help gossip propagate
      bitcoin_cli generatetoaddress 1 "$MINE_ADDR" > /dev/null
      [[ $WAITED -ge $MAX_WAIT ]] && err "Channel did not become active within ${MAX_WAIT}s"
    done

    ok "⚡ Lightning channel active! (1M sats, 200k pushed to seller)"
  fi
else
  warn "--skip-channel passed; skipping channel open."
fi

# ── 9. Deploy Ethereum HTLC contract ──────────────────────────────────────────
log "Deploying HashedTimelockETH to Ganache…"

# Wait for Ganache
MAX_WAIT=30; WAITED=0
until curl -sf -X POST http://localhost:8545 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' &>/dev/null; do
  sleep 2; WAITED=$((WAITED + 2))
  [[ $WAITED -ge $MAX_WAIT ]] && err "Ganache did not start within ${MAX_WAIT}s"
done
ok "Ganache is ready (chainId=$(curl -sf -X POST http://localhost:8545 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | jq -r '.result'))"

# Compile and deploy
cd "${ROOT}/packages/ethereum"
pnpm exec hardhat compile 2>&1 | tail -3
pnpm exec hardhat run scripts/deploy.ts --network localhost 2>&1

# The deploy script writes ETH_HTLC_CONTRACT_ADDRESS to .env.local
if [[ -f "${ROOT}/.env.local" ]]; then
  CONTRACT_ADDR=$(grep 'ETH_HTLC_CONTRACT_ADDRESS' "${ROOT}/.env.local" | cut -d= -f2)
  ok "HTLC contract deployed at: ${CONTRACT_ADDR}"
else
  warn "Could not find .env.local — contract address may not be persisted."
fi

# ── 10. Write runtime .env.local ─────────────────────────────────────────────
cd "${ROOT}"
log "Writing runtime values to .env.local…"

# Persist LND TLS cert paths (mounted inside Docker but accessible on host via docker cp)
mkdir -p "${ROOT}/.lnd-certs"
docker cp agentswap-buyer-lnd:/root/.lnd/tls.cert "${ROOT}/.lnd-certs/buyer-tls.cert" 2>/dev/null || true
docker cp agentswap-seller-lnd:/root/.lnd/tls.cert "${ROOT}/.lnd-certs/seller-tls.cert" 2>/dev/null || true

cat >> "${ROOT}/.env.local" <<EOF

# ── Runtime values written by start-demo.sh ──────────────────────────────────
BUYER_LND_REST_URL=https://localhost:8080
SELLER_LND_REST_URL=https://localhost:8081
BUYER_LND_TLS_CERT_PATH=${ROOT}/.lnd-certs/buyer-tls.cert
SELLER_LND_TLS_CERT_PATH=${ROOT}/.lnd-certs/seller-tls.cert
ETH_RPC_URL=http://localhost:8545
# Account[0] from the default Ganache mnemonic — has 1000 ETH pre-funded
ETH_BUYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ETH_SELLER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
ETH_BUYER_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
EOF

ok ".env.local updated"

# ── 11. Start the dashboard ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  AgentSwap is ready!  ${RESET}"
echo -e "${GREEN}  Dashboard → http://localhost:3000${RESET}"
echo -e "${GREEN}════════════════════════════════════════════════════${RESET}"
echo ""

cd "${ROOT}/packages/dashboard"

# Export combined env for Next.js
set -a
[[ -f "${ROOT}/.env" ]]       && source "${ROOT}/.env"
[[ -f "${ROOT}/.env.local" ]] && source "${ROOT}/.env.local"
set +a

pnpm dev
