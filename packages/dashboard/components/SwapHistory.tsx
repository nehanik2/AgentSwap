"use client";

/**
 * packages/dashboard/components/SwapHistory.tsx
 *
 * Collapsible bottom panel showing all swaps run in the current session.
 * Each row is compact when collapsed; click to expand for full details.
 * Includes a "Run Another Demo" button and a link to the full swap detail page.
 */

import { useState } from "react";
import Link from "next/link";
import type { DashboardSwapState } from "../hooks/useSSE.js";
import { formatSats, formatWei, truncateHash } from "../lib/explorerLinks.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  const cfg: Record<string, { color: string; bg: string; label: string }> = {
    SETTLED:     { color: "#22c55e",  bg: "rgba(34,197,94,0.12)",   label: "✓ SETTLED" },
    REFUNDED:    { color: "#ef4444",  bg: "rgba(239,68,68,0.12)",   label: "↩ REFUNDED" },
    EVALUATING:  { color: "#F59E0B",  bg: "rgba(245,158,11,0.12)",  label: "⚖ EVALUATING" },
    LOCKED:      { color: "#F7931A",  bg: "rgba(247,147,26,0.12)",  label: "🔐 LOCKED" },
    NEGOTIATING: { color: "#7F77DD",  bg: "rgba(127,119,221,0.12)", label: "💬 NEGOTIATING" },
    APPROVED:    { color: "#22c55e",  bg: "rgba(34,197,94,0.08)",   label: "✓ APPROVED" },
  };
  const s = cfg[state] ?? { color: "#666", bg: "rgba(255,255,255,0.05)", label: state };

  return (
    <span
      className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ color: s.color, background: s.bg, border: `1px solid ${s.color}30` }}
    >
      {s.label}
    </span>
  );
}

// ── ExpandedDetail ────────────────────────────────────────────────────────────

function ExpandedDetail({ swap }: { swap: DashboardSwapState }) {
  const btcAmount = swap.btcAmountLocked ?? swap.btcAmountSats ?? "";
  const ethAmount = swap.ethAmountLocked ?? swap.ethAmountWei  ?? "";

  const durationSec = swap.settledAt && swap.startedAt
    ? Math.round((swap.settledAt - swap.startedAt) / 1000)
    : null;

  const rows: [string, string][] = [
    ["Swap ID",      swap.swapId],
    ["Task",         swap.taskDescription ?? "—"],
    ["BTC Amount",   btcAmount ? formatSats(btcAmount) : "—"],
    ["ETH Amount",   ethAmount ? formatWei(ethAmount) : "—"],
    ["BTC Hash",     swap.btcRHash    ? truncateHash(swap.btcRHash, 16)   : "—"],
    ["ETH Lock ID",  swap.ethLockId   ? truncateHash(swap.ethLockId, 16)  : "—"],
    ["Preimage",     swap.preimageHex ? truncateHash(swap.preimageHex, 16) : "—"],
    ["Messages",     `${swap.messages.length} messages`],
    ...(durationSec !== null ? [["Duration", `${durationSec}s`] as [string, string]] : []),
    ...(swap.arbitratorScore !== undefined
      ? [["Arb Score", `${swap.arbitratorScore}/100`] as [string, string]] : []),
  ];

  return (
    <div
      className="mt-2 rounded-lg border overflow-hidden"
      style={{ background: "var(--color-bg)", borderColor: "#1e1e1e" }}
    >
      <div className="grid grid-cols-2 divide-x divide-y" style={{ borderColor: "#1e1e1e" }}>
        {rows.map(([label, value]) => (
          <div key={label} className="px-3 py-1.5 border-b" style={{ borderColor: "#1e1e1e" }}>
            <div className="text-[9px] uppercase tracking-widest text-[#444] mb-0.5">{label}</div>
            <div className="stat-mono text-[11px] text-[#888] break-all leading-snug">{value}</div>
          </div>
        ))}
      </div>

      {/* Arbitrator reasoning snippet */}
      {swap.arbitratorReasoning && (
        <div className="px-3 py-2 border-t" style={{ borderColor: "#1e1e1e" }}>
          <div className="text-[9px] uppercase tracking-widest text-[#444] mb-1">Arbitrator Reasoning</div>
          <p className="text-[11px] text-[#666] leading-relaxed line-clamp-2">
            {swap.arbitratorReasoning}
          </p>
        </div>
      )}

      {/* View full page link */}
      <div className="px-3 py-2 border-t flex justify-end" style={{ borderColor: "#1e1e1e" }}>
        <Link
          href={`/swap/${swap.swapId}`}
          className="text-[11px] font-semibold px-3 py-1 rounded-lg transition-opacity hover:opacity-80"
          style={{
            color:      "#7F77DD",
            background: "rgba(127,119,221,0.1)",
            border:     "1px solid rgba(127,119,221,0.2)",
          }}
        >
          Full detail →
        </Link>
      </div>
    </div>
  );
}

// ── SwapRow ───────────────────────────────────────────────────────────────────

function SwapRow({
  swap,
  isActive,
  onSelect,
  expanded,
  onToggle,
}: {
  swap:     DashboardSwapState;
  isActive: boolean;
  onSelect: (id: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const btcAmount = swap.btcAmountLocked ?? swap.btcAmountSats ?? "";

  const startedAt = new Date(swap.startedAt).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div
      className="border rounded-lg overflow-hidden transition-all duration-200"
      style={{
        borderColor: isActive
          ? "rgba(127,119,221,0.35)"
          : expanded
          ? "rgba(255,255,255,0.1)"
          : "#1e1e1e",
        background: isActive ? "rgba(127,119,221,0.04)" : "transparent",
      }}
    >
      {/* Compact row */}
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/[0.02] transition-colors duration-150"
        onClick={onToggle}
      >
        {/* Active indicator */}
        <span
          className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${isActive ? "breathe" : ""}`}
          style={{ background: isActive ? "#7F77DD" : "#333" }}
        />

        {/* Swap ID */}
        <span className="stat-mono text-[10px] text-[#555] flex-shrink-0 w-[60px]">
          {swap.swapId.slice(0, 7)}…
        </span>

        {/* Task description */}
        <span className="text-[11px] text-[#777] flex-1 truncate">
          {swap.taskDescription ?? "—"}
        </span>

        {/* Amounts */}
        <span className="stat-mono text-[10px] text-[#555] flex-shrink-0 hidden sm:block">
          {btcAmount ? `${parseInt(btcAmount, 10).toLocaleString()} sats` : "—"}
        </span>

        {/* State badge */}
        <StateBadge state={swap.state} />

        {/* Timestamp */}
        <span className="stat-mono text-[10px] text-[#444] flex-shrink-0 hidden md:block">
          {startedAt}
        </span>

        {/* "Watch" button */}
        {!isActive && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(swap.swapId); }}
            className="text-[10px] px-2 py-0.5 rounded transition-opacity hover:opacity-80 flex-shrink-0"
            style={{
              color:      "#7F77DD",
              background: "rgba(127,119,221,0.1)",
              border:     "1px solid rgba(127,119,221,0.2)",
            }}
          >
            watch
          </button>
        )}

        {/* Expand caret */}
        <span
          className="text-[#444] text-[10px] flex-shrink-0 transition-transform duration-200"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ▾
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 message-in">
          <ExpandedDetail swap={swap} />
        </div>
      )}
    </div>
  );
}

// ── SwapHistory ───────────────────────────────────────────────────────────────

export interface SwapHistoryProps {
  swaps:        Map<string, DashboardSwapState>;
  activeSwapId: string | null;
  onSelect:     (swapId: string) => void;
  onNewDemo:    () => void;
  isStarting:   boolean;
}

export function SwapHistory({
  swaps,
  activeSwapId,
  onSelect,
  onNewDemo,
  isStarting,
}: SwapHistoryProps) {
  const [open,        setOpen]        = useState(false);
  const [expandedId,  setExpandedId]  = useState<string | null>(null);

  const swapList = Array.from(swaps.values()).sort((a, b) => b.startedAt - a.startedAt);
  const count    = swapList.length;

  // Stats for the tab pill
  const settled  = swapList.filter((s) => s.settled).length;
  const refunded = swapList.filter((s) => s.refunded).length;

  if (count === 0) return null;

  return (
    <div
      className="flex-shrink-0 border-t"
      style={{ background: "var(--color-bg-panel)", borderColor: "#1a1a1a" }}
    >
      {/* Tab row */}
      <div
        className="flex items-center justify-between px-5 py-2 cursor-pointer hover:bg-white/[0.015] transition-colors duration-150 select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold text-[#555] uppercase tracking-widest">
            Session History
          </span>

          {/* Count badges */}
          <div className="flex items-center gap-1.5">
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
              style={{ color: "#888", background: "rgba(255,255,255,0.06)", border: "1px solid #272727" }}
            >
              {count} swap{count !== 1 ? "s" : ""}
            </span>
            {settled > 0 && (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
                style={{ color: "#22c55e", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)" }}
              >
                {settled} settled
              </span>
            )}
            {refunded > 0 && (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
                style={{ color: "#ef4444", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
              >
                {refunded} refunded
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Run Another Demo button */}
          <button
            onClick={(e) => { e.stopPropagation(); onNewDemo(); }}
            disabled={isStarting}
            className="text-[11px] font-bold px-3 py-1 rounded-lg transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color:      "#fff",
              background: isStarting ? "#333" : "linear-gradient(135deg, #7F77DD, #5B54C8)",
              boxShadow:  isStarting ? "none" : "0 0 12px rgba(127,119,221,0.25)",
            }}
          >
            {isStarting ? "Starting…" : "+ Run Another Demo"}
          </button>

          {/* Expand caret */}
          <span
            className="text-[#444] text-xs transition-transform duration-200"
            style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            ▾
          </span>
        </div>
      </div>

      {/* Expanded list */}
      {open && (
        <div className="px-5 pb-3 space-y-1.5 max-h-[40vh] overflow-y-auto message-in">
          {swapList.map((swap) => (
            <SwapRow
              key      ={swap.swapId}
              swap     ={swap}
              isActive ={swap.swapId === activeSwapId}
              onSelect ={onSelect}
              expanded ={expandedId === swap.swapId}
              onToggle ={() => setExpandedId((id) => id === swap.swapId ? null : swap.swapId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
