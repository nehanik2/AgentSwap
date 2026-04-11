"use client";

/**
 * packages/dashboard/app/page.tsx
 *
 * AgentSwap live demo dashboard.
 *
 * Layout: 3-column CSS grid (25% / 50% / 25%)
 *   Left  — Buyer Agent panel  (purple #7F77DD)
 *   Center — Swap state machine + arbitrator verdict
 *   Right — Seller Agent panel (teal #1D9E75)
 *
 * "Start Demo" calls POST /swap/start, then the entire lifecycle is
 * driven by SSE events from the Express server.
 */

import { useEffect, useRef, useState } from "react";
import { AgentPanel, type HTLCStatus } from "../components/AgentPanel.js";
import { SwapCenter } from "../components/SwapCenter.js";
import { StatsBar } from "../components/StatsBar.js";
import { SwapHistory } from "../components/SwapHistory.js";
import { PreimageReveal } from "../components/PreimageReveal.js";
import { useSSE, SERVER_URL, type DashboardSwapState, type ConnectionStatus } from "../hooks/useSSE.js";
import type { AgentMessage } from "@agentswap/shared";

// ── Demo task presets ─────────────────────────────────────────────────────────

const DEMO_TASKS = [
  "Write a 200-word summary of the history of Bitcoin in plain English.",
  "Translate the phrase 'The future is trustless' into French, Spanish, and Japanese.",
  "Draft a professional email declining a meeting request politely.",
  "List 5 creative names for an AI startup focused on cross-chain DeFi.",
  "Write a haiku about atomic swaps and the beauty of trustlessness.",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function htlcStatus(swap: DashboardSwapState | undefined, chain: "btc" | "eth"): HTLCStatus {
  if (!swap) return "idle";
  if (swap.refunded) return "refunded";
  if (swap.settled)  return "settled";
  const isLocked =
    chain === "btc" ? !!swap.btcRHash
    : !!swap.ethLockId;
  return isLocked ? "locked" : "idle";
}

function btcBalance(swap: DashboardSwapState | undefined): string {
  const START = 100_000;
  if (!swap?.btcAmountSats) return `${START.toLocaleString()} sats`;
  const locked = parseInt(swap.btcAmountSats, 10);
  const remaining = START - (isNaN(locked) ? 0 : locked);
  return `${Math.max(0, remaining).toLocaleString()} sats`;
}

function ethBalance(swap: DashboardSwapState | undefined): string {
  if (swap?.settled && swap.ethAmountWei) {
    try {
      const wei   = BigInt(swap.ethAmountWei);
      const units = wei / BigInt("100000000000000");
      const eth   = Number(units) / 10_000;
      return `+${eth.toFixed(4)} ETH received`;
    } catch { /* fallthrough */ }
  }
  return "0.0000 ETH";
}

// Messages for each agent panel
function buyerMessages(swap?: DashboardSwapState): AgentMessage[] {
  if (!swap) return [];
  return swap.messages.filter(m => m.role === "buyer" || m.role === "arbitrator");
}

function sellerMessages(swap?: DashboardSwapState): AgentMessage[] {
  if (!swap) return [];
  return swap.messages.filter(m => m.role === "seller" || m.role === "arbitrator");
}

// ── ConnectionDot ─────────────────────────────────────────────────────────────

function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const color =
    status === "connected"    ? "#22c55e"
    : status === "connecting" ? "#F59E0B"
    : "#ef4444";
  const pulse = status === "connecting" || status === "connected";

  return (
    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "#555" }}>
      <span
        className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${pulse ? "breathe" : ""}`}
        style={{ background: color }}
      />
      {status === "connected"    ? "live"
       : status === "connecting" ? "connecting…"
       : status === "disconnected" ? "reconnecting…"
       : "error"}
    </div>
  );
}

// ── Home ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [activeSwapId,       setActiveSwapId]       = useState<string | null>(null);
  const [isStarting,         setIsStarting]         = useState(false);
  const [selectedTask,       setSelectedTask]       = useState<string>(DEMO_TASKS[0]);
  const [startError,         setStartError]         = useState<string | null>(null);
  const [showPreimage,       setShowPreimage]       = useState(false);
  const prevSettledRef = useRef(false);

  const { swaps, connectionStatus } = useSSE(activeSwapId ?? undefined);
  const activeSwap = activeSwapId ? swaps.get(activeSwapId) : undefined;

  // Fire the PreimageReveal overlay exactly once when the active swap settles
  useEffect(() => {
    if (activeSwap?.settled && !prevSettledRef.current) {
      prevSettledRef.current = true;
      setShowPreimage(true);
    }
    if (!activeSwap?.settled) {
      prevSettledRef.current = false;
    }
  }, [activeSwap?.settled]);

  // ── Start demo ─────────────────────────────────────────────────────────────

  const startDemo = async () => {
    if (isStarting) return;
    setIsStarting(true);
    setStartError(null);

    try {
      const res = await fetch(`${SERVER_URL}/swap/start`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          taskDescription: selectedTask,
          buyerBudgetSats: 100_000,
        }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const { swapId } = (await res.json()) as { swapId: string };
      setActiveSwapId(swapId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const isLive    = activeSwap !== undefined;
  const isTerminal = activeSwap?.settled || activeSwap?.refunded;

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "#0f0f0f" }}>

      {/* ── Preimage reveal overlay (fires on settlement) ── */}
      {showPreimage && activeSwap?.preimageHex && (
        <PreimageReveal
          preimageHex={activeSwap.preimageHex}
          visible    ={showPreimage}
          onDismiss  ={() => setShowPreimage(false)}
        />
      )}

      {/* ── Top header bar ── */}
      <header
        className="flex-shrink-0 flex items-center justify-between px-5 py-2.5 border-b z-10"
        style={{ background: "#0d0d0d", borderColor: "#1e1e1e" }}
      >
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div
            className="h-7 w-7 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #7F77DD, #1D9E75)", color: "#fff" }}
          >
            ⚡
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-white leading-none">AgentSwap</div>
            <div className="text-[10px] text-[#444] leading-none mt-0.5">
              Cross-chain AI escrow · Bitcoin × Ethereum
            </div>
          </div>
        </div>

        {/* Center: task selector + start button */}
        <div className="flex items-center gap-2 flex-1 max-w-xl mx-6">
          <select
            value={selectedTask}
            onChange={(e) => setSelectedTask(e.target.value)}
            disabled={isStarting || (isLive && !isTerminal)}
            className="flex-1 rounded-lg px-3 py-1.5 text-xs text-[#ccc] border appearance-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
            style={{
              background:   "#1a1a1a",
              borderColor:  "#333",
            }}
          >
            {DEMO_TASKS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <button
            onClick={startDemo}
            disabled={isStarting || (isLive && !isTerminal)}
            className="flex-shrink-0 rounded-lg px-4 py-1.5 text-xs font-bold tracking-wide transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: isStarting
                ? "#333"
                : "linear-gradient(135deg, #7F77DD, #5B54C8)",
              color:      "#fff",
              boxShadow:  isStarting ? "none" : "0 0 16px rgba(127,119,221,0.3)",
            }}
          >
            {isStarting
              ? "Starting…"
              : isLive && !isTerminal
              ? "In Progress"
              : isTerminal
              ? "↺ New Demo"
              : "▶ Start Demo"}
          </button>
        </div>

        {/* Right: connection + swap ID */}
        <div className="flex items-center gap-4">
          {activeSwapId && (
            <div className="text-[10px] font-mono text-[#333]">
              {activeSwapId.slice(0, 8)}…
            </div>
          )}
          <ConnectionDot status={connectionStatus} />
          <div className="text-[10px] text-[#2a2a2a] border border-[#2a2a2a] rounded px-1.5 py-0.5 font-mono">
            BTC regtest · Ganache
          </div>
        </div>
      </header>

      {/* ── Live session stats bar ── */}
      <StatsBar swaps={swaps} />

      {/* ── Error banner ── */}
      {startError && (
        <div
          className="flex-shrink-0 px-5 py-2 text-xs text-[#ef4444] border-b"
          style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.2)" }}
        >
          ⚠️ {startError}
        </div>
      )}

      {/* ── 3-column main grid ── */}
      <main className="flex-1 grid min-h-0 overflow-hidden" style={{ gridTemplateColumns: "1fr 2fr 1fr" }}>

        {/* LEFT — Buyer Agent */}
        <AgentPanel
          role         ="buyer"
          agentName    ="Buyer Agent"
          chainLabel   ="Bitcoin Lightning"
          walletBalance={btcBalance(activeSwap)}
          messages     ={buyerMessages(activeSwap)}
          htlcStatus   ={htlcStatus(activeSwap, "btc")}
          color        ="#7F77DD"
        />

        {/* CENTER — Swap state machine */}
        <SwapCenter
          swap            ={activeSwap}
          taskDescription ={activeSwap?.taskDescription ?? (isLive ? undefined : selectedTask)}
        />

        {/* RIGHT — Seller Agent */}
        <AgentPanel
          role         ="seller"
          agentName    ="Seller Agent"
          chainLabel   ="Ethereum"
          walletBalance={ethBalance(activeSwap)}
          messages     ={sellerMessages(activeSwap)}
          htlcStatus   ={htlcStatus(activeSwap, "eth")}
          color        ="#1D9E75"
        />
      </main>

      {/* ── Session swap history ── */}
      <SwapHistory
        swaps       ={swaps}
        activeSwapId={activeSwapId}
        onSelect    ={(id) => { setActiveSwapId(id); }}
        onNewDemo   ={startDemo}
        isStarting  ={isStarting}
      />

      {/* ── Bottom status strip ── */}
      <footer
        className="flex-shrink-0 flex items-center justify-between px-5 py-1.5 border-t"
        style={{ background: "#0a0a0a", borderColor: "#1a1a1a" }}
      >
        <div className="flex items-center gap-4 text-[10px] text-[#333] font-mono">
          <span>AgentSwap v0.1.0</span>
          <span>·</span>
          <span>Built with Claude Sonnet 4.6</span>
          <span>·</span>
          <span>Zero humans harmed</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-[#333]">
          {activeSwap && (
            <>
              <span className="font-mono">{activeSwap.state}</span>
              <span>·</span>
              <span>{activeSwap.messages.length} msgs</span>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
