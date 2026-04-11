"use client";

import { useState, useEffect, useRef } from "react";
import type { AgentMessage, SwapState } from "@agentswap/shared";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SwapSession {
  swapId: string;
  state: SwapState | "PENDING";
  messages: AgentMessage[];
  error?: string;
  complete: boolean;
}

// ── Colour map for agent roles and swap states ────────────────────────────────

const ROLE_STYLES: Record<string, string> = {
  buyer: "bg-blue-900/50 border-blue-500/40 text-blue-100",
  seller: "bg-emerald-900/50 border-emerald-500/40 text-emerald-100",
  arbitrator: "bg-amber-900/50 border-amber-500/40 text-amber-100",
};

const ROLE_BADGE: Record<string, string> = {
  buyer: "bg-blue-500",
  seller: "bg-emerald-500",
  arbitrator: "bg-amber-500",
};

const STATE_COLOR: Record<string, string> = {
  PENDING: "text-slate-400",
  NEGOTIATING: "text-sky-400",
  LOCKED: "text-violet-400",
  EVALUATING: "text-amber-400",
  APPROVED: "text-lime-400",
  SETTLED: "text-emerald-400",
  REFUNDED: "text-rose-400",
};

const STATE_ICON: Record<string, string> = {
  PENDING: "⏳",
  NEGOTIATING: "💬",
  LOCKED: "🔒",
  EVALUATING: "🔍",
  APPROVED: "✅",
  SETTLED: "🎉",
  REFUNDED: "↩️",
};

// ── Demo tasks ────────────────────────────────────────────────────────────────

const DEMO_TASKS = [
  "Write a 200-word summary of the history of Bitcoin in plain English.",
  "Translate 'The quick brown fox jumps over the lazy dog' into French, Spanish, and Japanese.",
  "Draft a professional email declining a meeting request politely.",
  "List 5 creative names for an AI startup focused on cross-chain DeFi.",
  "Write a haiku about atomic swaps and trustlessness.",
];

// ── Main Component ────────────────────────────────────────────────────────────

export default function Home() {
  const [task, setTask] = useState("");
  const [session, setSession] = useState<SwapSession | null>(null);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length]);

  // Cleanup SSE on unmount
  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  const startSwap = async () => {
    if (!task.trim() || loading) return;
    setLoading(true);
    eventSourceRef.current?.close();

    const initSession: SwapSession = {
      swapId: "pending",
      state: "PENDING",
      messages: [],
      complete: false,
    };
    setSession(initSession);

    try {
      const res = await fetch("/api/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskDescription: task }),
      });
      const { swapId } = (await res.json()) as { swapId: string };

      // Open SSE stream
      const es = new EventSource(`/api/swap/stream?swapId=${swapId}`);
      eventSourceRef.current = es;

      es.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data) as AgentMessage;
        setSession((prev) => prev
          ? { ...prev, swapId, messages: [...prev.messages, msg] }
          : prev);
      });

      es.addEventListener("stateChange", (e) => {
        const { state } = JSON.parse(e.data) as { state: SwapState };
        setSession((prev) => prev ? { ...prev, swapId, state } : prev);
      });

      es.addEventListener("complete", () => {
        setSession((prev) => prev ? { ...prev, complete: true } : prev);
        es.close();
        setLoading(false);
      });

      es.addEventListener("error", (e) => {
        const payload = (e as MessageEvent).data
          ? JSON.parse((e as MessageEvent).data)
          : { message: "Unknown error" };
        setSession((prev) => prev
          ? { ...prev, error: payload.message as string, complete: true }
          : prev);
        es.close();
        setLoading(false);
      });

    } catch (err) {
      setSession((prev) => prev
        ? { ...prev, error: String(err), complete: true }
        : prev);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚡</span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">AgentSwap</h1>
            <p className="text-xs text-slate-500">Cross-chain atomic escrow · AI-negotiated · trustless</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          BTC Regtest + Ganache
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">

        {/* Input Panel */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">New Swap</h2>
          <textarea
            className="w-full rounded-lg bg-slate-800 border border-slate-700 text-slate-100 p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-sky-500 placeholder:text-slate-600"
            rows={3}
            placeholder="Describe the task the buyer wants the seller to complete…"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={loading}
          />

          {/* Quick picks */}
          <div className="flex flex-wrap gap-2">
            {DEMO_TASKS.map((t) => (
              <button
                key={t}
                onClick={() => setTask(t)}
                className="text-xs px-3 py-1 rounded-full border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
                disabled={loading}
              >
                {t.slice(0, 40)}…
              </button>
            ))}
          </div>

          <button
            onClick={startSwap}
            disabled={loading || !task.trim()}
            className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-semibold transition-colors"
          >
            {loading ? "Swap in progress…" : "⚡ Start Atomic Swap"}
          </button>
        </section>

        {/* Live Session */}
        {session && (
          <section className="space-y-4">
            {/* State banner */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">{STATE_ICON[session.state] ?? "⏳"}</span>
                <span className={`text-sm font-bold ${STATE_COLOR[session.state] ?? "text-slate-400"}`}>
                  {session.state}
                </span>
              </div>
              <span className="text-xs text-slate-600">
                {session.swapId !== "pending" ? `ID: ${session.swapId.slice(0, 8)}…` : "Initialising…"}
              </span>
            </div>

            {/* Progress bar */}
            {loading && (
              <div className="h-0.5 w-full bg-slate-800 rounded overflow-hidden">
                <div className="h-full bg-sky-500 animate-progress" style={{ width: "60%" }} />
              </div>
            )}

            {/* Message feed */}
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {session.messages.map((msg, i) => (
                <div
                  key={i}
                  className={`rounded-lg border p-4 text-sm ${ROLE_STYLES[msg.role] ?? "bg-slate-800 border-slate-700"}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold text-white ${ROLE_BADGE[msg.role] ?? "bg-slate-500"}`}>
                      {msg.role}
                    </span>
                    <span className="text-xs text-slate-500">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                </div>
              ))}

              {/* Loading indicator */}
              {loading && session.messages.length > 0 && (
                <div className="flex items-center gap-2 text-slate-600 text-sm px-4">
                  <span className="animate-spin">⟳</span>
                  <span>Agents thinking…</span>
                </div>
              )}

              {/* Error */}
              {session.error && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-900/30 p-4 text-rose-300 text-sm">
                  <strong>Error:</strong> {session.error}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Settled summary */}
            {session.complete && !session.error && (
              <div className={`rounded-xl border p-5 text-center ${
                session.state === "SETTLED"
                  ? "border-emerald-500/40 bg-emerald-900/20 text-emerald-300"
                  : "border-rose-500/40 bg-rose-900/20 text-rose-300"
              }`}>
                <p className="text-2xl mb-1">{STATE_ICON[session.state] ?? "✅"}</p>
                <p className="font-semibold">
                  {session.state === "SETTLED" ? "Swap settled trustlessly!" : "Swap refunded."}
                </p>
                <p className="text-xs mt-1 opacity-70">
                  {session.messages.length} agent messages · {session.swapId}
                </p>
              </div>
            )}
          </section>
        )}

        {/* Empty state */}
        {!session && (
          <div className="text-center py-16 text-slate-700 space-y-2">
            <p className="text-4xl">⚡🔒</p>
            <p className="text-sm">Start a swap to watch AI agents negotiate, lock funds, and settle trustlessly.</p>
          </div>
        )}
      </main>

      <style jsx global>{`
        @keyframes progress {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
        .animate-progress {
          animation: progress 1.5s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
