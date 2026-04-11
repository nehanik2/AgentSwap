"use client";

/**
 * packages/dashboard/components/TransactionPanel.tsx
 *
 * Shown after settlement in the center column.
 * Displays real transaction data for both chains with block-explorer links
 * and a visual connecting line that demonstrates the atomic nature of the swap —
 * the same 32-byte preimage unlocks funds on both chains simultaneously.
 */

import { useState } from "react";
import type { DashboardSwapState } from "../hooks/useSSE.js";
import {
  getEtherscanUrl,
  getLightningExplorerUrl,
  formatSats,
  formatWei,
  truncateHash,
} from "../lib/explorerLinks.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      onClick={copy}
      className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-mono transition-all duration-200"
      style={{
        color:      copied ? "#22c55e" : "#555",
        background: copied ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.04)",
        border:     `1px solid ${copied ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)"}`,
      }}
      title="Copy to clipboard"
    >
      {copied ? "✓" : "copy"}
    </button>
  );
}

function DataRow({
  label,
  value,
  mono = true,
  copyable = false,
  dim = false,
  highlight,
}: {
  label:     string;
  value:     string;
  mono?:     boolean;
  copyable?: boolean;
  dim?:      boolean;
  highlight?: string; // hex color for value
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
      <span className="text-[10px] uppercase tracking-widest text-[#444] flex-shrink-0 pt-0.5">{label}</span>
      <div className="flex items-center gap-0 min-w-0 flex-1 justify-end">
        <span
          className={`text-right break-all ${mono ? "stat-mono" : ""} text-[11px] leading-relaxed`}
          style={{ color: highlight ?? (dim ? "#555" : "#bbb") }}
        >
          {value}
        </span>
        {copyable && <CopyButton text={value} />}
      </div>
    </div>
  );
}

function ExternalLink({ href, label, color }: { href: string; label: string; color: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-all duration-200 hover:opacity-80"
      style={{
        color,
        background: `${color}12`,
        border:     `1px solid ${color}30`,
      }}
    >
      {label}
      <span className="text-[9px] opacity-60">↗</span>
    </a>
  );
}

// ── Chain block ───────────────────────────────────────────────────────────────

function ChainBlock({
  chain,
  color,
  icon,
  title,
  rows,
  explorerHref,
  explorerLabel,
  preimageHex,
  preimageLabel,
}: {
  chain:         "btc" | "eth";
  color:         string;
  icon:          string;
  title:         string;
  rows:          { label: string; value: string; copyable?: boolean; mono?: boolean }[];
  explorerHref:  string;
  explorerLabel: string;
  preimageHex:   string;
  preimageLabel: string;
}) {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: `${color}07`, borderColor: `${color}25` }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5 flex items-center justify-between border-b"
        style={{
          background:   `${color}10`,
          borderColor:  `${color}20`,
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-7 w-7 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
            style={{ background: `${color}20`, color }}
          >
            {icon}
          </span>
          <div>
            <div className="text-xs font-bold" style={{ color }}>{title}</div>
            <div className="text-[10px] text-[#444]">
              {chain === "btc" ? "Lightning · Regtest" : "Ethereum · Ganache"}
            </div>
          </div>
        </div>
        <div
          className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full"
          style={{
            color:      "#22c55e",
            background: "rgba(34,197,94,0.12)",
            border:     "1px solid rgba(34,197,94,0.3)",
          }}
        >
          SETTLED ✓
        </div>
      </div>

      {/* Data rows */}
      <div className="px-4 py-1">
        {rows.map((r) => (
          <DataRow
            key={r.label}
            label={r.label}
            value={r.value}
            copyable={r.copyable}
            mono={r.mono ?? true}
          />
        ))}
      </div>

      {/* Preimage reveal */}
      <div className="mx-4 mb-3 mt-1 rounded-lg border p-3" style={{ background: "rgba(34,197,94,0.04)", borderColor: "rgba(34,197,94,0.18)" }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-widest text-[#22c55e] opacity-70">
            Preimage
          </span>
          <span className="text-[10px] text-[#444] italic">{preimageLabel}</span>
        </div>
        <div className="flex items-start gap-1">
          <span className="stat-mono text-[10px] text-[#22c55e] break-all leading-relaxed flex-1">
            {preimageHex}
          </span>
          <CopyButton text={preimageHex} />
        </div>
      </div>

      {/* Explorer link */}
      <div className="px-4 pb-3">
        <ExternalLink href={explorerHref} label={explorerLabel} color={color} />
      </div>
    </div>
  );
}

// ── AtomicConnector ───────────────────────────────────────────────────────────

function AtomicConnector() {
  return (
    <div className="flex flex-col items-center py-1 gap-0 select-none">
      {/* Top vertical line */}
      <div className="w-px h-4 connector-draw" style={{ background: "linear-gradient(180deg, rgba(34,197,94,0.4), rgba(34,197,94,0.6))" }} />

      {/* Label pill */}
      <div
        className="px-3 py-1 rounded-full text-[10px] font-semibold tracking-widest uppercase flex items-center gap-2 badge-pop"
        style={{
          background:  "rgba(34,197,94,0.08)",
          border:      "1px solid rgba(34,197,94,0.3)",
          color:       "#22c55e",
          boxShadow:   "0 0 16px rgba(34,197,94,0.12)",
        }}
      >
        <span style={{ fontSize: "8px" }}>⬡</span>
        Atomic · same preimage · two chains
        <span style={{ fontSize: "8px" }}>⬡</span>
      </div>

      {/* Bottom vertical line */}
      <div className="w-px h-4 connector-draw" style={{ background: "linear-gradient(180deg, rgba(34,197,94,0.6), rgba(34,197,94,0.4))" }} />
    </div>
  );
}

// ── TransactionPanel ──────────────────────────────────────────────────────────

export interface TransactionPanelProps {
  swap: DashboardSwapState;
}

export function TransactionPanel({ swap }: TransactionPanelProps) {
  const preimage  = swap.preimageHex ?? "";
  const btcAmount = swap.btcAmountLocked ?? swap.btcAmountSats ?? "";
  const ethAmount = swap.ethAmountLocked ?? swap.ethAmountWei  ?? "";

  const settledTime = swap.settledAt
    ? new Date(swap.settledAt).toLocaleString([], {
        year:   "numeric", month:  "short", day:    "numeric",
        hour:   "2-digit", minute: "2-digit", second: "2-digit",
      })
    : "—";

  const durationSec = swap.settledAt && swap.startedAt
    ? Math.round((swap.settledAt - swap.startedAt) / 1000)
    : null;

  // BTC rows
  const btcRows = [
    { label: "Payment Hash", value: swap.btcRHash ?? "—", copyable: true },
    { label: "Amount",       value: btcAmount ? formatSats(btcAmount) : "—", mono: true },
    { label: "Invoice",      value: swap.btcPaymentRequest ? truncateHash(swap.btcPaymentRequest, 24) : "—" },
    ...(swap.btcTxId ? [{ label: "Tx ID", value: swap.btcTxId, copyable: true }] : []),
    { label: "Settled at",   value: settledTime, mono: false },
    ...(durationSec !== null ? [{ label: "Duration", value: `${durationSec}s end-to-end`, mono: false }] : []),
  ];

  // ETH rows
  const ethRows = [
    { label: "Lock ID",    value: swap.ethLockId ?? "—",   copyable: true },
    { label: "Amount",     value: ethAmount ? formatWei(ethAmount) : "—", mono: true },
    ...(swap.ethTxId ? [{ label: "Tx Hash", value: truncateHash(swap.ethTxId, 20), copyable: true }] : []),
    { label: "Settled at", value: settledTime, mono: false },
  ];

  const btcExplorerHref = swap.btcRHash
    ? getLightningExplorerUrl(swap.btcRHash)
    : "https://1ml.com";

  const ethExplorerHref = swap.ethTxId
    ? getEtherscanUrl(swap.ethTxId, "sepolia")
    : swap.ethLockId
    ? getEtherscanUrl(swap.ethLockId, "sepolia")
    : "https://sepolia.etherscan.io";

  return (
    <div className="message-in space-y-0">
      {/* Section header */}
      <div className="px-1 pb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-widest text-[#444]">
          On-chain Settlement
        </div>
        {durationSec !== null && (
          <div
            className="text-[10px] font-mono px-2 py-0.5 rounded-full"
            style={{
              color:      "#22c55e",
              background: "rgba(34,197,94,0.08)",
              border:     "1px solid rgba(34,197,94,0.2)",
            }}
          >
            {durationSec}s total
          </div>
        )}
      </div>

      {/* BTC chain block */}
      <ChainBlock
        chain          ="btc"
        color          ="#F7931A"
        icon           ="₿"
        title          ="Bitcoin Lightning"
        rows           ={btcRows}
        explorerHref   ={btcExplorerHref}
        explorerLabel  ="View on 1ML"
        preimageHex    ={preimage}
        preimageLabel  ="Secret revealed — unlocks both chains"
      />

      {/* Atomic connector */}
      <AtomicConnector />

      {/* ETH chain block */}
      <ChainBlock
        chain          ="eth"
        color          ="#627EEA"
        icon           ="Ξ"
        title          ="Ethereum"
        rows           ={ethRows}
        explorerHref   ={ethExplorerHref}
        explorerLabel  ="View on Etherscan"
        preimageHex    ={preimage}
        preimageLabel  ="Same secret used on Ethereum"
      />
    </div>
  );
}
