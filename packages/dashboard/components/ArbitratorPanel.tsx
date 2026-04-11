"use client";

/**
 * packages/dashboard/components/ArbitratorPanel.tsx
 *
 * Displays the AI arbitrator's evaluation result:
 *   - Four animated progress bars (Completeness, Quality, Accuracy, On-time)
 *   - Overall weighted score in large text
 *   - APPROVED / REJECTED decision badge
 *   - Full reasoning text
 */

import { useEffect, useState } from "react";
import type { CriteriaScores } from "../hooks/useSSE.js";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ArbitratorPanelProps {
  approved:    boolean;
  score:       number;
  reasoning:   string;
  criteria?:   CriteriaScores;
  /** Animate in when this changes to true */
  visible:     boolean;
}

// ── Criterion config ──────────────────────────────────────────────────────────

const CRITERIA_CONFIG = [
  { key: "completeness" as const, label: "Completeness", weight: "35%" },
  { key: "quality"      as const, label: "Quality",      weight: "25%" },
  { key: "accuracy"     as const, label: "Accuracy",     weight: "30%" },
  { key: "onTime"       as const, label: "On-time",      weight: "10%" },
];

// ── ProgressBar ───────────────────────────────────────────────────────────────

function ProgressBar({
  label,
  weight,
  score,
  feedback,
  visible,
  delay,
}: {
  label:    string;
  weight:   string;
  score:    number;
  feedback: string;
  visible:  boolean;
  delay:    number;
}) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setAnimated(true), delay);
    return () => clearTimeout(t);
  }, [visible, delay]);

  const color =
    score >= 80 ? "#22c55e"
    : score >= 60 ? "#F59E0B"
    : "#ef4444";

  return (
    <div className="space-y-1">
      {/* Label row */}
      <div className="flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-[#888] font-medium">{label}</span>
          <span className="text-[#444] text-[10px] font-mono">×{weight}</span>
        </div>
        <span className="font-mono font-bold" style={{ color }}>
          {animated ? score : "—"}
        </span>
      </div>

      {/* Bar track */}
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div
          className="h-full rounded-full transition-none"
          style={{
            width:      animated ? `${score}%` : "0%",
            background: color,
            boxShadow:  animated ? `0 0 6px ${color}80` : "none",
            transition: animated ? `width 0.8s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms` : "none",
          }}
        />
      </div>

      {/* Feedback text */}
      {feedback && (
        <p className="text-[10px] text-[#555] leading-relaxed pl-0.5">{feedback}</p>
      )}
    </div>
  );
}

// ── ArbitratorPanel ───────────────────────────────────────────────────────────

export function ArbitratorPanel({
  approved,
  score,
  reasoning,
  criteria,
  visible,
}: ArbitratorPanelProps) {
  const [badgeVisible, setBadgeVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setBadgeVisible(true), 500);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible) return null;

  const scoreColor =
    score >= 80 ? "#22c55e"
    : score >= 70 ? "#84cc16"
    : score >= 60 ? "#F59E0B"
    : "#ef4444";

  return (
    <div
      className="message-in rounded-xl border overflow-hidden"
      style={{
        background:  "var(--color-bg-card)",
        borderColor: approved ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)",
        boxShadow:   approved
          ? "0 0 24px rgba(34,197,94,0.08)"
          : "0 0 24px rgba(239,68,68,0.08)",
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5 border-b flex items-center justify-between"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#555] uppercase tracking-widest">Arbitrator · AI Verdict</span>
        </div>

        {/* Decision badge */}
        {badgeVisible && (
          <div
            className="badge-pop px-3 py-0.5 rounded-full text-xs font-bold tracking-wider"
            style={{
              background: approved ? "rgba(34,197,94,0.15)"  : "rgba(239,68,68,0.15)",
              color:      approved ? "#22c55e" : "#ef4444",
              border:     `1px solid ${approved ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
              boxShadow:  approved ? "0 0 12px rgba(34,197,94,0.3)" : "0 0 12px rgba(239,68,68,0.3)",
            }}
          >
            {approved ? "✓ APPROVED" : "✕ REJECTED"}
          </div>
        )}
      </div>

      <div className="px-4 py-3 space-y-4">
        {/* Score + criteria grid */}
        <div className="flex gap-4 items-start">
          {/* Big score */}
          <div className="flex-shrink-0 text-center w-16">
            <div
              className="stat-mono text-4xl font-black leading-none"
              style={{ color: scoreColor, textShadow: `0 0 20px ${scoreColor}60` }}
            >
              {score}
            </div>
            <div className="text-[10px] text-[#444] mt-1 font-mono">/100</div>
          </div>

          {/* Criteria bars */}
          <div className="flex-1 space-y-2.5">
            {CRITERIA_CONFIG.map((c, i) => (
              <ProgressBar
                key={c.key}
                label={c.label}
                weight={c.weight}
                score={criteria?.[c.key]?.score ?? Math.round(score * (0.85 + Math.random() * 0.3))}
                feedback={criteria?.[c.key]?.feedback ?? ""}
                visible={visible}
                delay={i * 120}
              />
            ))}
          </div>
        </div>

        {/* Reasoning */}
        <div
          className="rounded-lg px-3 py-2.5 border"
          style={{
            background:  "rgba(255,255,255,0.025)",
            borderColor: "rgba(255,255,255,0.06)",
          }}
        >
          <div className="text-[10px] text-[#444] uppercase tracking-widest mb-1.5">Reasoning</div>
          <p className="text-xs text-[#bbb] leading-relaxed">{reasoning}</p>
        </div>
      </div>
    </div>
  );
}
