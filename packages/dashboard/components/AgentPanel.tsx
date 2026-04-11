"use client";

/**
 * packages/dashboard/components/AgentPanel.tsx
 *
 * Left (Buyer) and Right (Seller) agent panels.
 * Shows agent identity, wallet balance, HTLC status badge, and scrolling
 * message feed.
 */

import { useEffect, useRef } from "react";
import type { AgentMessage } from "@agentswap/shared";

// ── Props ─────────────────────────────────────────────────────────────────────

export type HTLCStatus = "idle" | "locked" | "settled" | "refunded";

export interface AgentPanelProps {
  role:          "buyer" | "seller";
  agentName:     string;
  /** e.g. "Bitcoin Lightning" or "Ethereum" */
  chainLabel:    string;
  walletBalance: string;
  messages:      AgentMessage[];
  htlcStatus:    HTLCStatus;
  /** Hex accent color, e.g. "#7F77DD" */
  color:         string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour:   "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

const ROLE_LABEL: Record<string, string> = {
  buyer:      "BUYER",
  seller:     "SELLER",
  arbitrator: "ARB",
  system:     "SYS",
};

const ROLE_DOT: Record<string, string> = {
  buyer:      "#7F77DD",
  seller:     "#1D9E75",
  arbitrator: "#F59E0B",
  system:     "#6b7280",
};

// ── HTLCStatusBadge ───────────────────────────────────────────────────────────

function HTLCStatusBadge({ status, color }: { status: HTLCStatus; color: string }) {
  if (status === "idle") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[#555]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#444]" />
        Awaiting lock
      </div>
    );
  }
  if (status === "locked") {
    return (
      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color }}>
        <span className="h-2 w-2 rounded-full dot-pulse" style={{ background: "#F59E0B" }} />
        HTLC LOCKED
      </div>
    );
  }
  if (status === "settled") {
    return (
      <div className="flex items-center gap-1.5 text-xs font-bold text-[#22c55e]">
        <span className="h-2 w-2 rounded-full bg-[#22c55e]" />
        SETTLED ✓
      </div>
    );
  }
  // refunded
  return (
    <div className="flex items-center gap-1.5 text-xs font-bold text-[#ef4444]">
      <span className="h-2 w-2 rounded-full bg-[#ef4444]" />
      REFUNDED
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: AgentMessage }) {
  const dotColor = ROLE_DOT[msg.role] ?? "#6b7280";
  const label    = ROLE_LABEL[msg.role] ?? msg.role.toUpperCase();

  const isArbitrator = msg.role === "arbitrator";
  const isSystem     = msg.content.startsWith("⚠️") || msg.content.startsWith("Starting");

  return (
    <div
      className="message-in rounded-lg px-3 py-2.5 text-xs leading-relaxed border"
      style={{
        background:   isArbitrator ? "rgba(245,158,11,0.06)" : isSystem ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.04)",
        borderColor:  isArbitrator ? "rgba(245,158,11,0.18)" : "rgba(255,255,255,0.07)",
      }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: dotColor }} />
          <span className="font-mono font-semibold text-[10px] tracking-widest" style={{ color: dotColor }}>
            {label}
          </span>
        </div>
        <span className="text-[#444] font-mono text-[10px]">{fmtTime(msg.timestamp)}</span>
      </div>
      {/* Content */}
      <p className="text-[#bbb] whitespace-pre-wrap break-words">{msg.content}</p>
    </div>
  );
}

// ── AgentPanel ────────────────────────────────────────────────────────────────

export function AgentPanel({
  role,
  agentName,
  chainLabel,
  walletBalance,
  messages,
  htlcStatus,
  color,
}: AgentPanelProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const inits = initials(agentName);

  return (
    <div
      className="flex flex-col h-full border-r border-[#1e1e1e] overflow-hidden"
      style={{ background: "var(--color-bg-panel)" }}
    >
      {/* ── Identity header ── */}
      <div
        className="flex-shrink-0 px-4 pt-4 pb-3 border-b"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-3">
          {/* Avatar */}
          <div
            className="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 select-none"
            style={{
              background: `${color}22`,
              border:     `1.5px solid ${color}55`,
              color,
            }}
          >
            {inits}
          </div>

          <div className="min-w-0">
            <div className="text-sm font-semibold text-white truncate">{agentName}</div>
            <div className="text-[11px] text-[#555] truncate">{chainLabel}</div>
          </div>
        </div>

        {/* Balance + HTLC status */}
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] text-[#444] uppercase tracking-widest mb-0.5">Balance</div>
            <div className="stat-mono text-sm font-semibold" style={{ color }}>
              {walletBalance}
            </div>
          </div>
          <HTLCStatusBadge status={htlcStatus} color={color} />
        </div>
      </div>

      {/* ── Chain accent bar ── */}
      <div className="h-px flex-shrink-0" style={{ background: `linear-gradient(90deg, ${color}40, transparent)` }} />

      {/* ── Message feed label ── */}
      <div
        className="flex-shrink-0 px-4 py-2 flex items-center justify-between border-b"
        style={{ borderColor: "rgba(255,255,255,0.04)" }}
      >
        <span className="text-[10px] uppercase tracking-widest text-[#444]">Feed</span>
        <span className="text-[10px] font-mono text-[#333]">{messages.length} msgs</span>
      </div>

      {/* ── Scrollable message feed ── */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2 min-h-0"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center select-none">
            <div className="text-3xl mb-2 float" style={{ color: `${color}33` }}>
              {role === "buyer" ? "₿" : "Ξ"}
            </div>
            <p className="text-[11px] text-[#333]">Waiting for negotiation…</p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={`${msg.timestamp}-${i}`} msg={msg} />
          ))
        )}
      </div>

      {/* ── Footer accent ── */}
      <div
        className="flex-shrink-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${color}30, transparent)` }}
      />
    </div>
  );
}
