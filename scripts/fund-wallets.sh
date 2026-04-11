#!/usr/bin/env bash
# =============================================================================
# AgentSwap — fund-wallets.sh
#
# Utility script to (re-)fund test wallets without running the full demo.
# Useful after a docker compose down -v when volumes are wiped.
#
# Usage:
#   bash scripts/fund-wallets.sh [--regtest] [--sepolia]
#   (default: --regtest only)
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[fund]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
err()  { echo -e "${RED}[✗]${RESET} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load env
[[ -f "${ROOT}/.env" ]]       && { set -a; source "${ROOT}/.env"; set +a; }
[[ -f "${ROOT}/.env.local" ]] && { set -a; source "${ROOT}/.env.local"; set +a; }

DO_REGTEST=true
DO_SEPOLIA=false

for arg in "$@"; do
  case $arg in
    --regtest) DO_REGTEST=true ;;
    --sepolia) DO_SEPOLIA=true; DO_REGTEST=false ;;
    --both)    DO_REGTEST=true; DO_SEPOLIA=true ;;
  esac
done

BTC_RPC_USER="${BITCOIN_RPC_USER:-agentswap}"
BTC_RPC_PASS="${BITCOIN_RPC_PASS:-agentswap}"

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

# ── Regtest funding ───────────────────────────────────────────────────────────
if [[ "$DO_REGTEST" == "true" ]]; then
  log "Funding regtest wallets…"

  # Verify containers are running
  docker inspect agentswap-bitcoind &>/dev/null || err "bitcoind container not running. Run: docker compose up -d"
  docker inspect agentswap-buyer-lnd &>/dev/null || err "buyer-lnd container not running."
  docker inspect agentswap-seller-lnd &>/dev/null || err "seller-lnd container not running."

  # Get addresses
  BUYER_ADDR=$(lncli_buyer newaddress p2wkh 2>/dev/null | jq -r '.address')
  SELLER_ADDR=$(lncli_seller newaddress p2wkh 2>/dev/null | jq -r '.address')
  MINE_ADDR=$(bitcoin_cli getnewaddress "" "bech32")

  log "Buyer  LND address: ${BUYER_ADDR}"
  log "Seller LND address: ${SELLER_ADDR}"

  # Fund with 5 BTC each for comfortable testing
  bitcoin_cli sendtoaddress "$BUYER_ADDR" 5 > /dev/null
  bitcoin_cli sendtoaddress "$SELLER_ADDR" 5 > /dev/null

  # Confirm
  bitcoin_cli generatetoaddress 6 "$MINE_ADDR" > /dev/null
  sleep 3

  BUYER_BAL=$(lncli_buyer walletbalance 2>/dev/null | jq -r '.confirmed_balance // "pending"')
  SELLER_BAL=$(lncli_seller walletbalance 2>/dev/null | jq -r '.confirmed_balance // "pending"')

  ok "Buyer  LND balance: ${BUYER_BAL} sats"
  ok "Seller LND balance: ${SELLER_BAL} sats"

  # Also top up the Ganache Ethereum accounts via direct RPC
  # (Ganache pre-funds them, but this confirms the RPC is alive)
  ETH_RPC="${ETH_RPC_URL:-http://localhost:8545}"
  ETH_BAL=$(curl -sf -X POST "$ETH_RPC" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","latest"],"id":1}' \
    | jq -r '.result' 2>/dev/null || echo "0x0")

  log "Ganache Account[0] balance: ${ETH_BAL} wei"
  ok "Regtest wallets funded successfully."
fi

# ── Sepolia funding (faucet links only — can't automate without a private key) ─
if [[ "$DO_SEPOLIA" == "true" ]]; then
  warn "Sepolia funding requires a real faucet. Automated funding is not supported."
  echo ""
  echo "  Recommended faucets:"
  echo "  • https://sepoliafaucet.com"
  echo "  • https://faucet.quicknode.com/ethereum/sepolia"
  echo "  • https://www.alchemy.com/faucets/ethereum-sepolia"
  echo ""
  echo "  Target addresses (from your .env):"
  echo "    ETH_BUYER_ADDRESS:  ${ETH_BUYER_ADDRESS:-not set}"

  # If a SEPOLIA_RPC_URL is configured, show current balance
  if [[ -n "${SEPOLIA_RPC_URL:-}" ]]; then
    ADDR="${ETH_BUYER_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
    BAL=$(curl -sf -X POST "$SEPOLIA_RPC_URL" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"${ADDR}\",\"latest\"],\"id\":1}" \
      | jq -r '.result' 2>/dev/null || echo "0x0")
    log "Current Sepolia balance for ${ADDR}: ${BAL} wei"
  fi
fi

log "Done."
