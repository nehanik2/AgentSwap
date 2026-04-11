"use client";

/**
 * packages/dashboard/components/StatsBar.tsx
 *
 * Slim stat strip shown between the header and the 3-column grid.
 * Aggregates live session data from all swaps tracked by the SSE hook.
 */

import type { DashboardSwapState } from "../hooks/useSSE.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sumSats(swaps: DashboardSwapState[]): string {
  let total = 0;
  for (const s of swaps) {
    const raw = s.btcAmountLocked ?? s.btcAmountSats ?? "0";
    const n   = parseInt(raw, 10);
    if (!isNaN(n)) total += n;
  }
  return total.toLocaleString();
}

function sumEth(swaps: DashboardSwapState[]): string {
  let total = BigInt(0);
  for (const s of swaps) {
    const raw = s.ethAmountLocked ?? s.ethAmountWei ?? "0";
    try { total += BigInt(raw); } catch { /* skip */ }
  }
  // Convert wei → ETH with 4 dp
  const units = total / BigInt("100000000000000");
  return (Number(units) / 10_000).toFixed(4);
}

function avgSettlementSec(swaps: DashboardSwapState[]): string {
  const settled = swaps.filter((s) => s.settled && s.settledAt && s.startedAt);
  if (settled.length === 0) return "—";
  const totalSec = settled.reduce(
    (acc, s) => acc + Math.round((s.settledAt! - s.startedAt) / 1000),
    0
  );
  return `${Math.round(totalSec / settled.length)}s`;
}

// ── StatCell ──────────────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  unit,
  color,
  large,
}: {
  label: string;
  value: string;
  unit?:  string;
  color?: string;
  large?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 border-r last:border-r-0" style={{ borderColor: "#1e1e1e" }}>
      <div className="flex flex-col">
        <span className="text-[9px] uppercase tracking-[0.2em] text-[#444]">{label}</span>
        <div className="flex items-baseline gap-1">
          <span
            className={`stat-mono font-bold leading-none ${large ? "text-base" : "text-sm"}`}
            style={{ color: color ?? "#888" }}
          >
            {value}
          </span>
          {unit && (
            <span className="text-[9px] text-[#444] font-mono">{unit}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── StatsBar ──────────────────────────────────────────────────────────────────

export interface StatsBarProps {
  swaps: Map<string, DashboardSwapState>;
}

export function StatsBar({ swaps }: StatsBarProps) {
  const all      = Array.from(swaps.values());
  const settled  = all.filter((s) => s.settled);
  const active   = all.filter((s) => !s.settled && !s.refunded);
  const refunded = all.filter((s) => s.refunded);

  const totalSats = sumSats(settled);
  const totalEth  = sumEth(settled);
  const avgSec    = avgSettlementSec(all);

  // Only show bar when there's at least one swap in session
  if (all.length === 0) return null;

  return (
    <div
      className="flex-shrink-0 flex items-stretch h-9 border-b overflow-x-auto scroll-hidden"
      style={{ background: "#0c0c0c", borderColor: "#1a1a1a" }}
    >
      {/* Humans involved — always 0, always prominent */}
      <div
        className="flex items-center gap-2 px-4 border-r flex-shrink-0"
        style={{ borderColor: "#1e1e1e", background: "rgba(34,197,94,0.03)" }}
      >
        <span className="text-[9px] uppercase tracking-[0.2em] text-[#444]">Humans</span>
        <span
          className="stat-mono text-base font-black leading-none"
          style={{
            color:      "#22c55e",
            textShadow: settled.length > 0
              ? "0 0 12px rgba(34,197,94,0.5)"
              : "none",
          }}
        >
          0
        </span>
      </div>

      <StatCell
        label="Swaps"
        value={String(all.length)}
        color="#aaa"
      />

      {settled.length > 0 && (
        <StatCell
          label="Settled"
          value={String(settled.length)}
          color="#22c55e"
        />
      )}

      {active.length > 0 && (
        <StatCell
          label="Active"
          value={String(active.length)}
          color="#F59E0B"
        />
      )}

      {refunded.length > 0 && (
        <StatCell
          label="Refunded"
          value={String(refunded.length)}
          color="#ef4444"
        />
      )}

      {settled.length > 0 && (
        <>
          <StatCell
            label="BTC Volume"
            value={totalSats}
            unit="sats"
            color="#F7931A"
          />
          <StatCell
            label="ETH Volume"
            value={totalEth}
            unit="ETH"
            color="#627EEA"
          />
          <StatCell
            label="Avg Settlement"
            value={avgSec}
            color="#7F77DD"
          />
        </>
      )}

      {/* Divider + tagline */}
      <div className="flex-1 flex items-center justify-end px-4">
        <span className="text-[9px] uppercase tracking-[0.2em] text-[#2a2a2a] font-mono whitespace-nowrap">
          Fully autonomous · zero trust required
        </span>
      </div>
    </div>
  );
}
