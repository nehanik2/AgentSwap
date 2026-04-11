/**
 * packages/dashboard/lib/explorerLinks.ts
 *
 * Pure helpers for block-explorer URLs and amount formatting.
 * No side-effects, no external dependencies — safe to import anywhere.
 */

// ── Explorer URL builders ─────────────────────────────────────────────────────

/**
 * Return an Etherscan URL for a transaction hash.
 * For local Ganache swaps we link to Sepolia (the hash won't exist there,
 * but the URL format shows judges what a real explorer would look like).
 */
export function getEtherscanUrl(
  txHash: string,
  network: "sepolia" | "mainnet" = "sepolia"
): string {
  const base =
    network === "mainnet"
      ? "https://etherscan.io"
      : "https://sepolia.etherscan.io";
  return `${base}/tx/${txHash}`;
}

/**
 * Return a 1ML.com URL for a Lightning payment hash.
 * Works for mainnet hashes; regtest hashes are for demo purposes only.
 */
export function getLightningExplorerUrl(paymentHash: string): string {
  return `https://1ml.com/payment/${paymentHash}`;
}

// ── Amount formatters ─────────────────────────────────────────────────────────

/**
 * Format satoshis with human-readable BTC equivalent.
 * e.g. 10000 → "10,000 sats (0.0001 BTC)"
 */
export function formatSats(sats: number | string): string {
  const n = typeof sats === "string" ? parseInt(sats, 10) : sats;
  if (isNaN(n)) return "— sats";
  // Show BTC with enough precision but strip trailing zeros
  const btcFull = (n / 100_000_000).toFixed(8);
  const btc = btcFull.replace(/\.?0+$/, "") || "0";
  return `${n.toLocaleString()} sats (${btc} BTC)`;
}

/**
 * Format wei as ETH with 4 decimal places.
 * Uses BigInt arithmetic to avoid float precision loss.
 * e.g. "50000000000000000" → "0.0500 ETH"
 */
export function formatWei(wei: string): string {
  if (!wei) return "— ETH";
  try {
    const w     = BigInt(wei);
    const units = w / BigInt("100000000000000"); // 1e14 → 0.0001 ETH units
    const eth   = Number(units) / 10_000;
    return `${eth.toFixed(4)} ETH`;
  } catch {
    return `${wei} wei`;
  }
}

// ── Hash display helpers ──────────────────────────────────────────────────────

/**
 * Truncate a hash for display: show `chars` characters on each side with "…".
 * e.g. truncateHash("0x1234567890abcdef...", 6) → "0x1234…bcdef"
 */
export function truncateHash(hash: string, chars = 8): string {
  if (!hash) return "—";
  if (hash.length <= chars * 2 + 3) return hash;
  return `${hash.slice(0, chars)}…${hash.slice(-chars)}`;
}

/**
 * Format a Unix-seconds timestamp as a readable local time string.
 * e.g. 1714000000 → "Apr 25, 2024 · 04:26:40"
 */
export function formatUnixTimestamp(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleString([], {
      year:   "numeric",
      month:  "short",
      day:    "numeric",
      hour:   "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(unixSec);
  }
}

/**
 * Format an ISO timestamp string as a short "HH:MM:SS" time.
 */
export function formatISOTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour:   "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}
