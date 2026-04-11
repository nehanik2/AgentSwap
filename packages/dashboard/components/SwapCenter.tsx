"use client";

/**
 * packages/dashboard/components/SwapCenter.tsx
 *
 * The center column — the visual heart of the demo.
 *
 *  ┌────────────────────────────────────────┐
 *  │  Phase stepper: NEGOTIATING → SETTLED  │
 *  │  Chain cards: BTC | ETH (flash green)  │
 *  │  "HUMANS INVOLVED: 0" counter          │
 *  │  Arbitrator verdict panel              │
 *  └────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from "react";
import type { DashboardSwapState } from "../hooks/useSSE.js";
import { ArbitratorPanel } from "./ArbitratorPanel.js";
import { TransactionPanel } from "./TransactionPanel.js";

// ── Phase definitions ─────────────────────────────────────────────────────────

const PHASES = [
  {
    id:    "NEGOTIATING",
    label: "Negotiate",
    desc:  "AI agents agree on terms",
    icon:  "💬",
    color: "#7F77DD",
  },
  {
    id:    "LOCKED",
    label: "Lock",
    desc:  "Funds escrowed on-chain",
    icon:  "🔐",
    color: "#F7931A",
  },
  {
    id:    "EVALUATING",
    label: "Evaluate",
    desc:  "Arbitrator reviews work",
    icon:  "⚖️",
    color: "#F59E0B",
  },
  {
    id:    "SETTLED",
    label: "Settle",
    desc:  "Atomic settlement",
    icon:  "✅",
    color: "#22c55e",
  },
] as const;

// ── Countdown timer hook ──────────────────────────────────────────────────────

function useCountdown(lockTimeSec?: number): string {
  const [display, setDisplay] = useState("—");

  useEffect(() => {
    if (!lockTimeSec) { setDisplay("—"); return; }

    function update() {
      const rem = Math.max(0, lockTimeSec! - Math.floor(Date.now() / 1000));
      if (rem === 0) { setDisplay("00:00:00"); return; }
      const h = Math.floor(rem / 3600);
      const m = Math.floor((rem % 3600) / 60);
      const s = rem % 60;
      setDisplay(
        `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
      );
    }

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [lockTimeSec]);

  return display;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSats(raw?: string): string {
  if (!raw) return "—";
  const n = parseInt(raw, 10);
  return isNaN(n) ? raw : n.toLocaleString() + " sats";
}

function formatEth(raw?: string): string {
  if (!raw) return "—";
  try {
    // Safe division: divide raw wei by 1e14 to get 0.0001-ETH units, then /10000
    const wei   = BigInt(raw);
    const units = wei / BigInt("100000000000000"); // 1e14
    const whole = Number(units);
    return (whole / 10_000).toFixed(4) + " ETH";
  } catch {
    return raw;
  }
}

function truncate(s?: string, n = 12): string {
  if (!s) return "—";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ── PhaseStepper ──────────────────────────────────────────────────────────────

function PhaseStepper({ state }: { state: string }) {
  const isRefunded = state === "REFUNDED";
  const activeIdx  = isRefunded ? 3 : ["NEGOTIATING", "LOCKED", "EVALUATING", "SETTLED"].indexOf(
    state === "APPROVED" ? "SETTLED"
    : state === "EVALUATING" ? "EVALUATING"
    : state === "LOCKED" ? "LOCKED"
    : state === "SETTLED" ? "SETTLED"
    : "NEGOTIATING"
  );

  return (
    <div className="flex items-center gap-0 w-full select-none">
      {PHASES.map((phase, i) => {
        const isActive   = i === activeIdx && !isRefunded;
        const isDone     = (i < activeIdx) || (state === "SETTLED" && i === 3);
        const isLastRefund = isRefunded && i === 3;

        return (
          <div key={phase.id} className="flex items-center flex-1 last:flex-none">
            {/* Phase node */}
            <div className="flex flex-col items-center gap-1 flex-shrink-0">
              {/* Icon circle */}
              <div
                className={`relative h-11 w-11 rounded-full flex items-center justify-center text-lg transition-all duration-500`}
                style={{
                  background: isLastRefund
                    ? "rgba(239,68,68,0.15)"
                    : isActive
                    ? `${phase.color}22`
                    : isDone
                    ? `${phase.color}15`
                    : "rgba(255,255,255,0.04)",
                  border: isLastRefund
                    ? "1.5px solid rgba(239,68,68,0.5)"
                    : isActive
                    ? `2px solid ${phase.color}`
                    : isDone
                    ? `1.5px solid ${phase.color}60`
                    : "1.5px solid rgba(255,255,255,0.1)",
                  boxShadow: isActive
                    ? `0 0 0 0 ${phase.color}80`
                    : "none",
                  // Animate ring-pulse via inline style hack
                  animation: isActive ? "ring-pulse 1.8s ease-out infinite" : "none",
                  // Custom prop for animation
                  ["--pulse-color" as string]: `${phase.color}80`,
                  ["--pulse-color-end" as string]: `${phase.color}00`,
                }}
              >
                {isLastRefund ? "↩" : isDone ? "✓" : phase.icon}
              </div>

              {/* Label */}
              <span
                className="text-[10px] font-semibold tracking-wide"
                style={{
                  color: isLastRefund ? "#ef4444"
                       : isActive     ? phase.color
                       : isDone       ? `${phase.color}aa`
                       : "#444",
                }}
              >
                {isLastRefund ? "REFUNDED" : phase.label.toUpperCase()}
              </span>

              {/* Description (active only) */}
              <span
                className="text-[9px] text-center max-w-[70px] leading-tight"
                style={{ color: isActive ? "#666" : "transparent", transition: "color 0.3s" }}
              >
                {phase.desc}
              </span>
            </div>

            {/* Connector — skip after last */}
            {i < PHASES.length - 1 && (
              <div
                className="flex-1 h-px mx-1 transition-all duration-500"
                style={{
                  background: isDone
                    ? `linear-gradient(90deg, ${phase.color}80, ${PHASES[i + 1]!.color}50)`
                    : "rgba(255,255,255,0.08)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── ChainCard ─────────────────────────────────────────────────────────────────

function ChainCard({
  chain,
  color,
  ticker,
  txHash,
  amount,
  lockTime,
  settled,
  refunded,
}: {
  chain:    "btc" | "eth";
  color:    string;
  ticker:   string;
  txHash?:  string;
  amount?:  string;
  lockTime?: number;
  settled:  boolean;
  refunded: boolean;
}) {
  const [flashed, setFlashed] = useState(false);
  const prevSettled = useRef(false);
  const countdown   = useCountdown(lockTime);

  // Trigger flash once on first settlement
  useEffect(() => {
    if (settled && !prevSettled.current) {
      prevSettled.current = true;
      setFlashed(true);
    }
  }, [settled]);

  const statusLabel = settled ? "SETTLED" : refunded ? "REFUNDED" : txHash ? "LOCKED" : "IDLE";
  const statusColor = settled ? "#22c55e" : refunded ? "#ef4444" : txHash ? "#F59E0B" : "#555";

  return (
    <div
      className={`flex-1 rounded-xl border p-3 space-y-2.5 transition-colors duration-500 ${flashed ? "settle-flash" : ""}`}
      style={{
        background:  `${color}09`,
        borderColor: settled ? "rgba(34,197,94,0.4)" : refunded ? "rgba(239,68,68,0.3)" : `${color}30`,
      }}
    >
      {/* Chain header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="h-7 w-7 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
            style={{ background: `${color}22`, color }}
          >
            {chain === "btc" ? "₿" : "Ξ"}
          </span>
          <span className="font-semibold text-sm" style={{ color }}>{ticker}</span>
        </div>
        <span
          className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full"
          style={{
            color:      statusColor,
            background: `${statusColor}18`,
            border:     `1px solid ${statusColor}40`,
          }}
        >
          {statusLabel}
        </span>
      </div>

      {/* Amount */}
      <div>
        <div className="text-[10px] text-[#444] uppercase tracking-widest mb-0.5">Amount</div>
        <div className="stat-mono text-sm font-semibold text-[#ddd]">
          {chain === "btc" ? formatSats(amount) : formatEth(amount)}
        </div>
      </div>

      {/* Hash / lock ID */}
      <div>
        <div className="text-[10px] text-[#444] uppercase tracking-widest mb-0.5">
          {chain === "btc" ? "rHash" : "Lock ID"}
        </div>
        <div className="stat-mono text-[11px] text-[#666] break-all">{truncate(txHash, 18)}</div>
      </div>

      {/* Timelock */}
      {lockTime && (
        <div>
          <div className="text-[10px] text-[#444] uppercase tracking-widest mb-0.5">Timelock</div>
          <div className="stat-mono text-sm font-semibold text-[#666]">{countdown}</div>
        </div>
      )}
    </div>
  );
}

// ── SwapCenter ────────────────────────────────────────────────────────────────

export interface SwapCenterProps {
  swap?: DashboardSwapState;
  taskDescription?: string;
}

export function SwapCenter({ swap, taskDescription }: SwapCenterProps) {
  const state     = swap?.state ?? "IDLE";
  const isSettled = swap?.settled ?? false;
  const isRefunded= swap?.refunded ?? false;
  const hasVerdict= !!(swap?.arbitratorReasoning && swap.arbitratorScore !== undefined);

  return (
    <div
      className="flex flex-col h-full overflow-y-auto overflow-x-hidden"
      style={{ background: "var(--color-bg)", borderLeft: "1px solid #1e1e1e", borderRight: "1px solid #1e1e1e" }}
    >
      {/* ── Task description ── */}
      {taskDescription && (
        <div
          className="flex-shrink-0 px-5 py-3 border-b text-xs text-[#666] leading-relaxed"
          style={{ borderColor: "#1e1e1e" }}
        >
          <span className="text-[#444] uppercase tracking-widest text-[10px] mr-2">Task</span>
          {taskDescription}
        </div>
      )}

      {/* ── Phase stepper ── */}
      <div className="flex-shrink-0 px-5 pt-5 pb-4">
        {swap ? (
          <PhaseStepper state={state} />
        ) : (
          <div className="flex items-center justify-center h-24 text-[#333] text-sm">
            Start a demo swap to watch the state machine live
          </div>
        )}
      </div>

      {/* ── Chain status cards ── */}
      {swap && (
        <div className="flex-shrink-0 px-4 pb-4 flex gap-3">
          <ChainCard
            chain    ="btc"
            color    ="#F7931A"
            ticker   ="Bitcoin Lightning"
            txHash   ={swap.btcRHash}
            amount   ={swap.btcAmountLocked ?? swap.btcAmountSats}
            lockTime ={swap.btcLockTime}
            settled  ={isSettled}
            refunded ={isRefunded}
          />
          <ChainCard
            chain    ="eth"
            color    ="#627EEA"
            ticker   ="Ethereum"
            txHash   ={swap.ethLockId}
            amount   ={swap.ethAmountLocked ?? swap.ethAmountWei}
            lockTime ={swap.ethLockTime}
            settled  ={isSettled}
            refunded ={isRefunded}
          />
        </div>
      )}

      {/* ── Divider ── */}
      <div className="flex-shrink-0 mx-5 h-px" style={{ background: "#1e1e1e" }} />

      {/* ── "HUMANS INVOLVED: 0" ── */}
      <div className="flex-shrink-0 px-5 py-6 text-center select-none">
        <div className="text-[10px] uppercase tracking-[0.25em] text-[#333] mb-1">
          Humans Involved
        </div>
        <div
          className="stat-mono text-7xl font-black leading-none"
          style={{
            color:      "#fff",
            textShadow: isSettled
              ? "0 0 40px rgba(34,197,94,0.5), 0 0 80px rgba(34,197,94,0.2)"
              : "none",
          }}
        >
          0
        </div>
        <div className="text-[10px] text-[#333] mt-2 tracking-wide">
          Fully autonomous · AI-negotiated · trustless
        </div>
      </div>

      {/* ── Divider ── */}
      <div className="flex-shrink-0 mx-5 h-px" style={{ background: "#1e1e1e" }} />

      {/* ── Arbitrator verdict ── */}
      <div className="flex-shrink-0 px-4 py-4">
        {hasVerdict ? (
          <ArbitratorPanel
            approved  ={swap!.arbitratorApproved ?? false}
            score     ={swap!.arbitratorScore!}
            reasoning ={swap!.arbitratorReasoning!}
            criteria  ={swap?.criteriaScores}
            visible   ={hasVerdict}
          />
        ) : swap ? (
          <div
            className="rounded-xl border px-4 py-5 text-center"
            style={{ background: "var(--color-bg-card)", borderColor: "#272727" }}
          >
            <div className="text-[11px] text-[#444] uppercase tracking-widest mb-2">
              Arbitrator · AI Verdict
            </div>
            <div className="text-[#333] text-sm">
              {["EVALUATING", "APPROVED"].includes(state)
                ? "⚖️  Evaluating deliverable…"
                : "Awaiting deliverable submission"}
            </div>
          </div>
        ) : null}
      </div>

      {/* Settlement celebration banner */}
      {isSettled && (
        <div
          className="flex-shrink-0 mx-4 mb-4 rounded-xl border px-4 py-3 text-center message-in"
          style={{
            background:   "rgba(34,197,94,0.06)",
            borderColor:  "rgba(34,197,94,0.25)",
            boxShadow:    "0 0 30px rgba(34,197,94,0.1)",
          }}
        >
          <div className="text-lg mb-0.5">🎉</div>
          <div className="text-sm font-bold text-[#22c55e]">Swap Settled Trustlessly</div>
          {swap?.preimageHex && (
            <div className="text-[10px] text-[#555] mt-1 font-mono break-all">
              preimage: 0x{swap.preimageHex.slice(0, 32)}…
            </div>
          )}
        </div>
      )}

      {isRefunded && (
        <div
          className="flex-shrink-0 mx-4 mb-4 rounded-xl border px-4 py-3 text-center message-in"
          style={{
            background:  "rgba(239,68,68,0.06)",
            borderColor: "rgba(239,68,68,0.25)",
          }}
        >
          <div className="text-sm font-bold text-[#ef4444]">↩ Swap Refunded</div>
          {swap?.refundReason && (
            <div className="text-[10px] text-[#666] mt-1">{swap.refundReason.slice(0, 120)}</div>
          )}
        </div>
      )}

      {/* ── On-chain transaction detail (settlement only) ── */}
      {isSettled && swap && (
        <div className="flex-shrink-0 px-4 pb-5">
          <TransactionPanel swap={swap} />
        </div>
      )}
    </div>
  );
}
