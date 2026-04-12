"use client";

/**
 * packages/dashboard/components/DemoController.tsx
 *
 * Collapsible demo control panel — lives at the bottom of the center column.
 *
 * Sections:
 *   PRESET SCENARIOS — one-click scenario launchers (server-side deterministic demo)
 *   SPEED CONTROLS   — Fast mode / Narrated mode toggles
 *   EMERGENCY        — Force Settle, Force Refund, Reset (live demo safety net)
 *
 * Design intent: dark, compact, judges-visible but not distracting.
 */

import { useState } from "react";
import { SERVER_URL } from "../hooks/useSSE.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DemoControllerProps {
  /** Currently active swap — needed for force-settle / force-refund. */
  activeSwapId: string | null;
  /** Whether the active swap is in a terminal state. */
  isTerminal: boolean;
  /** Current fast-mode setting — passed in so parent controls state. */
  fastMode: boolean;
  onFastModeChange: (v: boolean) => void;
  /** Current narrated-mode setting. */
  narratedMode: boolean;
  onNarratedModeChange: (v: boolean) => void;
  /** Called when a scenario swap successfully starts — returns the new swapId. */
  onScenarioStarted: (swapId: string) => void;
  /** Called when demo is reset. */
  onReset: () => void;
  /** Disable all controls while a swap is in flight. */
  disabled?: boolean;
}

// ── Scenario definitions (mirrors server-side demoScenarios.ts) ───────────────

const SCENARIOS = [
  {
    id:       "translation-task",
    label:    "Translation Task",
    desc:     "Good deliverable → SETTLED",
    icon:     "🌍",
    color:    "#22c55e",
    outcome:  "good" as const,
  },
  {
    id:       "code-review-task",
    label:    "Code Review",
    desc:     "Good deliverable → SETTLED",
    icon:     "🔍",
    color:    "#7F77DD",
    outcome:  "good" as const,
  },
  {
    id:       "bad-delivery-demo",
    label:    "Bad Delivery",
    desc:     "Garbage → REFUNDED",
    icon:     "💀",
    color:    "#ef4444",
    outcome:  "bad" as const,
  },
] as const;

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({
  label,
  checked,
  onChange,
  accentColor = "#7F77DD",
  disabled,
}: {
  label:       string;
  checked:     boolean;
  onChange:    (v: boolean) => void;
  accentColor?: string;
  disabled?:   boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed select-none"
      style={{
        background:  checked ? `${accentColor}18` : "rgba(255,255,255,0.04)",
        border:      `1px solid ${checked ? accentColor + "50" : "#2a2a2a"}`,
        color:       checked ? accentColor : "#555",
      }}
    >
      {/* Track */}
      <span
        className="relative inline-flex h-3 w-5 items-center rounded-full flex-shrink-0 transition-colors duration-200"
        style={{ background: checked ? accentColor : "#333" }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full bg-white transition-transform duration-200"
          style={{ transform: checked ? "translateX(10px)" : "translateX(2px)" }}
        />
      </span>
      {label}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-[0.2em] font-mono mb-1.5" style={{ color: "#3a3a3a" }}>
      {children}
    </div>
  );
}

// ── DemoController ────────────────────────────────────────────────────────────

export function DemoController({
  activeSwapId,
  isTerminal,
  fastMode,
  onFastModeChange,
  narratedMode,
  onNarratedModeChange,
  onScenarioStarted,
  onReset,
  disabled = false,
}: DemoControllerProps) {
  const [open,           setOpen]           = useState(true);
  const [launching,      setLaunching]      = useState<string | null>(null);
  const [settling,       setSettling]       = useState(false);
  const [refunding,      setRefunding]      = useState(false);
  const [resetting,      setResetting]      = useState(false);
  const [feedbackMsg,    setFeedbackMsg]    = useState<string | null>(null);
  const [feedbackOk,     setFeedbackOk]     = useState(true);

  function flash(msg: string, ok = true) {
    setFeedbackMsg(msg);
    setFeedbackOk(ok);
    setTimeout(() => setFeedbackMsg(null), 3000);
  }

  // ── Scenario launch ──────────────────────────────────────────────────────

  async function launchScenario(scenarioId: string) {
    if (launching || disabled) return;
    setLaunching(scenarioId);
    try {
      const speedMode = fastMode ? "fast" : narratedMode ? "narrated" : "normal";
      const res = await fetch(`${SERVER_URL}/demo/start-scenario`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ scenarioId, speedMode }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { swapId } = (await res.json()) as { swapId: string };
      onScenarioStarted(swapId);
      flash(`Scenario started — ${swapId.slice(0, 8)}…`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), false);
    } finally {
      setLaunching(null);
    }
  }

  // ── Force settle ─────────────────────────────────────────────────────────

  async function forceSettle() {
    if (!activeSwapId || settling) return;
    setSettling(true);
    try {
      const res = await fetch(`${SERVER_URL}/demo/force-settle/${activeSwapId}`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      flash("Force-settle triggered");
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), false);
    } finally {
      setSettling(false);
    }
  }

  // ── Force refund ─────────────────────────────────────────────────────────

  async function forceRefund() {
    if (!activeSwapId || refunding) return;
    setRefunding(true);
    try {
      const res = await fetch(`${SERVER_URL}/demo/force-refund/${activeSwapId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ reason: "Force-refund via demo controller" }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      flash("Force-refund triggered");
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), false);
    } finally {
      setRefunding(false);
    }
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  async function resetDemo() {
    if (resetting) return;
    setResetting(true);
    try {
      const res = await fetch(`${SERVER_URL}/demo/reset`, { method: "POST" });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { swapsRefunded?: number };
      flash(`Reset complete — ${body.swapsRefunded ?? 0} swap(s) cancelled`);
      onReset();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), false);
    } finally {
      setResetting(false);
    }
  }

  const hasActiveSwap  = !!activeSwapId && !isTerminal;
  const canForceAction = hasActiveSwap && !settling && !refunding;

  return (
    <div
      className="flex-shrink-0 border-t"
      style={{ background: "#0b0b0b", borderColor: "#1a1a1a" }}
    >
      {/* ── Collapse toggle ─── */}
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-1.5 text-[10px] uppercase tracking-[0.2em] font-mono transition-colors duration-150 select-none"
        style={{ color: "#333" }}
      >
        <span className="flex items-center gap-1.5">
          <span>🎮</span>
          Demo Controller
        </span>
        <span style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s", display: "inline-block" }}>
          ▾
        </span>
      </button>

      {/* ── Feedback flash ─── */}
      {feedbackMsg && (
        <div
          className="mx-4 mb-1.5 px-3 py-1.5 rounded-lg text-[11px] text-center message-in"
          style={{
            background:  feedbackOk ? "rgba(34,197,94,0.08)"  : "rgba(239,68,68,0.08)",
            border:      `1px solid ${feedbackOk ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
            color:       feedbackOk ? "#22c55e" : "#ef4444",
          }}
        >
          {feedbackMsg}
        </div>
      )}

      {/* ── Expanded panel ─── */}
      {open && (
        <div className="px-4 pb-3 space-y-3">

          {/* PRESET SCENARIOS */}
          <div>
            <SectionLabel>Preset Scenarios</SectionLabel>
            <div className="flex gap-2">
              {SCENARIOS.map((s) => {
                const isRunning = launching === s.id;
                const anyRunning = !!launching;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => launchScenario(s.id)}
                    disabled={anyRunning || (hasActiveSwap) || disabled}
                    className="flex-1 flex flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      background:  `${s.color}09`,
                      border:      `1px solid ${isRunning ? s.color + "60" : s.color + "20"}`,
                      boxShadow:   isRunning ? `0 0 12px ${s.color}18` : "none",
                    }}
                  >
                    <div className="flex items-center gap-1.5 w-full">
                      <span className="text-base leading-none">{s.icon}</span>
                      <span className="text-[11px] font-semibold leading-tight" style={{ color: s.color }}>
                        {isRunning ? "Starting…" : s.label}
                      </span>
                    </div>
                    <div className="text-[9px] leading-tight pl-5" style={{ color: s.color + "70" }}>
                      {s.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* SPEED CONTROLS */}
          <div>
            <SectionLabel>Speed Controls</SectionLabel>
            <div className="flex gap-2">
              <Toggle
                label="Fast Mode"
                checked={fastMode}
                onChange={(v) => { onFastModeChange(v); if (v) onNarratedModeChange(false); }}
                accentColor="#F7931A"
                disabled={disabled}
              />
              <Toggle
                label="Narrated Mode"
                checked={narratedMode}
                onChange={(v) => { onNarratedModeChange(v); if (v) onFastModeChange(false); }}
                accentColor="#7F77DD"
                disabled={disabled}
              />
            </div>
            {narratedMode && (
              <div className="mt-1.5 text-[9px] text-[#444] leading-relaxed">
                Narrated mode shows phase overlays timed for presenting to judges.
              </div>
            )}
          </div>

          {/* EMERGENCY OVERRIDES */}
          <div>
            <SectionLabel>Emergency Overrides</SectionLabel>
            <div className="flex gap-2">
              {/* Force Settle */}
              <button
                type="button"
                onClick={forceSettle}
                disabled={!canForceAction}
                className="flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background:  "rgba(34,197,94,0.07)",
                  border:      "1px solid rgba(34,197,94,0.2)",
                  color:       "#22c55e",
                }}
              >
                {settling ? "Settling…" : "⚡ Force Settle"}
              </button>

              {/* Force Refund */}
              <button
                type="button"
                onClick={forceRefund}
                disabled={!canForceAction}
                className="flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background:  "rgba(239,68,68,0.07)",
                  border:      "1px solid rgba(239,68,68,0.2)",
                  color:       "#ef4444",
                }}
              >
                {refunding ? "Refunding…" : "↩ Force Refund"}
              </button>

              {/* Reset Demo */}
              <button
                type="button"
                onClick={resetDemo}
                disabled={resetting}
                className="flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background:  "rgba(255,255,255,0.04)",
                  border:      "1px solid #2a2a2a",
                  color:       "#555",
                }}
              >
                {resetting ? "Resetting…" : "🗑 Reset Demo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
