#!/usr/bin/env bash
# =============================================================================
# AgentSwap — reset-demo-env.sh
#
# Complete environment reset for a clean demo.
#
# What this does:
#   1. Stops ALL containers and wipes ALL volumes (full clean slate)
#   2. Restarts the full Docker stack
#   3. Waits for bitcoind + both LND nodes to be ready
#   4. Creates a fresh Lightning channel (2M sats capacity, 500k pushed to seller)
#   5. Deploys a fresh AgentSwapHTLC contract to Ganache
#   6. Funds the Ganache ETH wallets (already pre-funded by default)
#   7. Runs the preflight check
#   8. Reports readiness
#
# Usage:
#   bash scripts/reset-demo-env.sh
#   bash scripts/reset-demo-env.sh --skip-preflight   (skip final check)
#
# ⚠  DESTRUCTIVE: ALL existing LND channel state and Bitcoin balances are lost.
#    Run this only when you want a completely fresh environment.
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[reset]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET}  $*"; }
warn() { echo -e "${YELLOW}[!]${RESET}  $*"; }
err()  { echo -e "${RED}[✗]${RESET}  $*"; exit 1; }
step() { echo -e "\n${BOLD}${CYAN}══ Step $1: $2 ══${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SKIP_PREFLIGHT=false
for arg in "$@"; do
  [[ "$arg" == "--skip-preflight" ]] && SKIP_PREFLIGHT=true
done

# ── Load env ──────────────────────────────────────────────────────────────────
if [[ -f "${ROOT}/.env" ]]; then
  set -a; source "${ROOT}/.env"; set +a
fi

BTC_RPC_USER="${BITCOIN_RPC_USER:-agentswap}"
BTC_RPC_PASS="${BITCOIN_RPC_PASS:-agentswap}"

# ── Docker helpers ────────────────────────────────────────────────────────────
bitcoin_cli() {
  docker exec agentswap-bitcoind bitcoin-cli \
    -regtest -rpcuser="${BTC_RPC_USER}" -rpcpassword="${BTC_RPC_PASS}" "$@"
}

lncli_buyer() {
  docker exec agentswap-buyer-lnd lncli \
    --network=regtest --no-macaroons --rpcserver=localhost:10009 "$@"
}

lncli_seller() {
  docker exec agentswap-seller-lnd lncli \
    --network=regtest --no-macaroons --rpcserver=localhost:10009 "$@"
}

wait_ready() {
  local label="$1"; local cmd="$2"; local max=120; local waited=0
  log "Waiting for ${label}…"
  until eval "${cmd}" &>/dev/null; do
    sleep 2; waited=$((waited + 2))
    (( waited % 10 == 0 )) && log "  still waiting for ${label} (${waited}s elapsed)…"
    [[ $waited -ge $max ]] && err "${label} did not become ready within ${max}s"
  done
  ok "${label} is ready"
}

# ── Step 1: Stop all containers + wipe volumes ───────────────────────────────
step 1 "Stop containers and wipe volumes"
log "Stopping Docker stack and removing volumes…"
docker compose -f "${ROOT}/docker-compose.yml" down -v --remove-orphans 2>/dev/null || true
ok "All containers stopped and volumes removed"

# ── Step 2: Restart Docker stack ─────────────────────────────────────────────
step 2 "Start fresh Docker stack"
log "Starting Docker services (bitcoind + buyer-lnd + seller-lnd + ganache)…"
docker compose -f "${ROOT}/docker-compose.yml" up -d --remove-orphans
ok "Docker services started"

# ── Step 3: Wait for bitcoind ─────────────────────────────────────────────────
step 3 "Wait for bitcoind and LND nodes"
wait_ready "bitcoind" "bitcoin_cli getblockchaininfo"
ok "bitcoind ready (height=$(bitcoin_cli getblockcount))"

wait_ready "buyer-lnd" "lncli_buyer getinfo"
wait_ready "seller-lnd" "lncli_seller getinfo"

# ── Step 4: Mine initial blocks ───────────────────────────────────────────────
step 4 "Mine initial blocks"
MINE_ADDR=$(bitcoin_cli getnewaddress "" "bech32")
log "Mining 150 segwit-activation + coinbase-maturity blocks…"
bitcoin_cli generatetoaddress 150 "${MINE_ADDR}" > /dev/null
ok "Mined 150 blocks (height=$(bitcoin_cli getblockcount))"

# ── Step 5: Fund LND wallets ──────────────────────────────────────────────────
step 5 "Fund LND wallets"
log "Getting LND wallet addresses…"
BUYER_LND_ADDR=$(lncli_buyer newaddress p2wkh 2>/dev/null | jq -r '.address')
SELLER_LND_ADDR=$(lncli_seller newaddress p2wkh 2>/dev/null | jq -r '.address')

[[ -z "$BUYER_LND_ADDR" ]]  && err "Could not get buyer LND address"
[[ -z "$SELLER_LND_ADDR" ]] && err "Could not get seller LND address"

log "Buyer  LND address: ${BUYER_LND_ADDR}"
log "Seller LND address: ${SELLER_LND_ADDR}"

# Fund 3 BTC each to ensure enough for 2M-sat channel + fees
bitcoin_cli sendtoaddress "${BUYER_LND_ADDR}"  3 > /dev/null
bitcoin_cli sendtoaddress "${SELLER_LND_ADDR}" 3 > /dev/null
bitcoin_cli generatetoaddress 6 "${MINE_ADDR}" > /dev/null
ok "Funded LND wallets (3 BTC each, 6 confirmations)"

# Wait for LND to see confirmed balance
log "Waiting for LND to see confirmed balance…"
sleep 5

MAX_WAIT=60; WAITED=0
until [[ "$(lncli_buyer walletbalance 2>/dev/null | jq '.confirmed_balance // 0' 2>/dev/null)" -gt 0 ]] 2>/dev/null; do
  sleep 3; WAITED=$((WAITED + 3))
  [[ $WAITED -ge $MAX_WAIT ]] && err "Buyer LND did not see confirmed balance after ${MAX_WAIT}s"
done
ok "LND buyer confirmed balance: $(lncli_buyer walletbalance 2>/dev/null | jq -r '.confirmed_balance') sats"

# ── Step 6: Connect + open 2M-sat channel ────────────────────────────────────
step 6 "Open 2M-sat Lightning channel (buyer → seller)"
SELLER_PUBKEY=$(lncli_seller getinfo 2>/dev/null | jq -r '.identity_pubkey')
[[ -z "$SELLER_PUBKEY" ]] && err "Could not get seller pubkey"
log "Seller pubkey: ${SELLER_PUBKEY}"

# Connect buyer → seller P2P
lncli_buyer connect "${SELLER_PUBKEY}@agentswap-seller-lnd:9735" 2>/dev/null || true
sleep 2

# Open 2M-sat channel, push 500k sats to seller (both sides have liquidity)
log "Opening channel: 2 000 000 sats capacity, 500 000 pushed to seller…"
CHAN_RESULT=$(lncli_buyer openchannel \
  --node_key="${SELLER_PUBKEY}" \
  --local_amt=2000000 \
  --push_amt=500000 \
  --spend_unconfirmed 2>/dev/null)

log "Channel pending: ${CHAN_RESULT}"

# Confirm the channel open
bitcoin_cli generatetoaddress 6 "${MINE_ADDR}" > /dev/null
sleep 5

# Wait for channel to become active
log "Waiting for channel to become active…"
MAX_WAIT=90; WAITED=0
until [[ "$(lncli_buyer listchannels 2>/dev/null | jq '[.channels[] | select(.active == true)] | length')" -gt 0 ]]; do
  sleep 3; WAITED=$((WAITED + 3))
  bitcoin_cli generatetoaddress 1 "${MINE_ADDR}" > /dev/null
  [[ $WAITED -ge $MAX_WAIT ]] && err "Channel did not become active within ${MAX_WAIT}s"
done

LOCAL_BAL=$(lncli_buyer listchannels 2>/dev/null \
  | jq '[.channels[] | select(.active == true) | .local_balance | tonumber] | add // 0')
REMOTE_BAL=$(lncli_buyer listchannels 2>/dev/null \
  | jq '[.channels[] | select(.active == true) | .remote_balance | tonumber] | add // 0')

ok "⚡ Lightning channel ACTIVE"
ok "   Buyer  local:  ${LOCAL_BAL} sats"
ok "   Seller remote: ${REMOTE_BAL} sats"

# ── Step 7: Deploy fresh Ethereum contract ────────────────────────────────────
step 7 "Deploy AgentSwapHTLC to Ganache"

# Wait for Ganache
MAX_WAIT=30; WAITED=0
until curl -sf -X POST http://localhost:8545 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' &>/dev/null; do
  sleep 2; WAITED=$((WAITED + 2))
  [[ $WAITED -ge $MAX_WAIT ]] && err "Ganache did not start within ${MAX_WAIT}s"
done
ok "Ganache ready"

# Build + deploy
cd "${ROOT}/packages/ethereum"
log "Compiling Solidity contracts…"
pnpm exec hardhat compile --quiet 2>&1 | tail -3

log "Deploying AgentSwapHTLC to Ganache…"
pnpm exec hardhat run scripts/deployAgentSwapHTLC.ts --network localhost 2>&1

if [[ -f "${ROOT}/.env.local" ]]; then
  CONTRACT_ADDR=$(grep 'AGENTSWAP_HTLC_CONTRACT_ADDRESS' "${ROOT}/.env.local" 2>/dev/null | tail -1 | cut -d= -f2)
  [[ -n "$CONTRACT_ADDR" ]] && ok "AgentSwapHTLC deployed at: ${CONTRACT_ADDR}"
fi

cd "${ROOT}"

# ── Step 8: Persist LND TLS certs ────────────────────────────────────────────
step 8 "Export LND TLS certificates"
mkdir -p "${ROOT}/.lnd-certs"
docker cp agentswap-buyer-lnd:/root/.lnd/tls.cert  "${ROOT}/.lnd-certs/buyer-tls.cert"  2>/dev/null && ok "Buyer  TLS cert saved" || warn "Could not copy buyer  TLS cert (non-fatal)"
docker cp agentswap-seller-lnd:/root/.lnd/tls.cert "${ROOT}/.lnd-certs/seller-tls.cert" 2>/dev/null && ok "Seller TLS cert saved" || warn "Could not copy seller TLS cert (non-fatal)"

# ── Step 9: Preflight check ───────────────────────────────────────────────────
step 9 "Run preflight check"

if [[ "$SKIP_PREFLIGHT" == "true" ]]; then
  warn "Skipping preflight (--skip-preflight passed)"
else
  log "Running preflight-check.ts…"
  if pnpm preflight; then
    ok "Preflight passed"
  else
    warn "Preflight reported failures — check output above before presenting"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  🟢  Demo environment READY${RESET}"
echo -e "${GREEN}  Channel:  2 000 000 sat capacity | ~1 500 000 buyer local${RESET}"
echo -e "${GREEN}  Contract: Fresh AgentSwapHTLC deployed${RESET}"
echo -e "${GREEN}  Ganache:  Accounts funded with 1 000 ETH each${RESET}"
echo ""
echo -e "${GREEN}  Next steps:${RESET}"
echo -e "${GREEN}    1. Start the API server:    pnpm --filter @agentswap/server dev${RESET}"
echo -e "${GREEN}    2. Start the dashboard:     pnpm --filter @agentswap/dashboard dev${RESET}"
echo -e "${GREEN}    3. Verify everything:       pnpm preflight${RESET}"
echo -e "${GREEN}    4. Simulate demo timing:    pnpm simulate-demo${RESET}"
echo ""
echo -e "${YELLOW}  Estimated time to settlement:  ~45 seconds${RESET}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════${RESET}"
echo ""
