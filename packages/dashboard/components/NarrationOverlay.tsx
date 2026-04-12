"use client";

/**
 * packages/dashboard/components/NarrationOverlay.tsx
 *
 * Full-width narration banner shown during "Narrated mode" demos.
 * Appears at the bottom-center of the viewport on each phase transition,
 * renders the narration text with a typewriter effect, then fades out
 * after 4 seconds.
 *
 * Designed to be spoken aloud by the presenter — the on-screen text
 * gives judges context for what they're watching.
 */

import { useEffect, useRef, useState } from "react";
import { PhaseNarrator } from "./PhaseNarrator.js";

// ── Narration map ─────────────────────────────────────────────────────────────

interface NarrationLine {
  text:    string;
  icon:    string;
  /** Hex accent colour for the border/glow. */
  color:   string;
}

function getNarration(state: string, score?: number): NarrationLine | null {
  switch (state) {
    case "NEGOTIATING":
      return {
        text:  "Two AI agents are negotiating contract terms. No humans involved.",
        icon:  "💬",
        color: "#7F77DD",
      };
    case "LOCKED":
      return {
        text:  "Both chains are now locked. Neither party can cheat — the cryptography enforces this.",
        icon:  "🔐",
        color: "#F7931A",
      };
    case "EVALUATING":
      return {
        text:  "The AI arbitrator is reading the contract spec and the deliverable…",
        icon:  "⚖️",
        color: "#F59E0B",
      };
    case "APPROVED":
      return {
        text:  score !== undefined
          ? `Score: ${score}/100. Arbitrator approves. Preimage being revealed…`
          : "Arbitrator approves. Preimage being revealed…",
        icon:  "✅",
        color: "#22c55e",
      };
    case "SETTLED":
      return {
        text:  "Both chains settled. The same 32-byte secret unlocked Bitcoin AND Ethereum.",
        icon:  "🎉",
        color: "#22c55e",
      };
    case "REFUNDED":
      return {
        text:  score !== undefined
          ? `Deliverable rejected. Score: ${score}/100. Buyer refunded on both chains.`
          : "Deliverable rejected. Buyer refunded on both chains.",
        icon:  "↩",
        color: "#ef4444",
      };
    default:
      return null;
  }
}

// ── NarrationOverlay ──────────────────────────────────────────────────────────

const AUTO_DISMISS_MS = 4_000;
const FADE_MS         = 500;

export interface NarrationOverlayProps {
  /** Current swap state string (e.g. "LOCKED"). Undefined when no swap active. */
  state?:   string;
  /** Arbitrator score — shown in APPROVED/REFUNDED narration. */
  score?:   number;
  /** When false the overlay never appears. */
  enabled:  boolean;
}

export function NarrationOverlay({ state, score, enabled }: NarrationOverlayProps) {
  const [currentLine, setCurrentLine] = useState<NarrationLine | null>(null);
  const [visible,     setVisible]     = useState(false);
  const [fading,      setFading]      = useState(false);

  const prevStateRef = useRef<string | undefined>(undefined);
  const dismissRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !state) return;
    if (state === prevStateRef.current) return; // no change

    prevStateRef.current = state;

    const line = getNarration(state, score);
    if (!line) return;

    // Clear any pending timers from the previous narration
    if (dismissRef.current) clearTimeout(dismissRef.current);
    if (fadeRef.current)    clearTimeout(fadeRef.current);

    setCurrentLine(line);
    setFading(false);
    setVisible(true);

    // Auto-dismiss after hold period
    dismissRef.current = setTimeout(() => {
      setFading(true);
      fadeRef.current = setTimeout(() => {
        setVisible(false);
        setFading(false);
      }, FADE_MS);
    }, AUTO_DISMISS_MS);
  }, [enabled, state, score]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
      if (fadeRef.current)    clearTimeout(fadeRef.current);
    };
  }, []);

  if (!enabled || !visible || !currentLine) return null;

  return (
    <div
      className="fixed bottom-8 left-1/2 z-50 message-in"
      style={{
        transform:  "translateX(-50%)",
        opacity:    fading ? 0 : 1,
        transition: fading ? `opacity ${FADE_MS}ms ease-in` : "none",
        pointerEvents: "none",
        minWidth: "480px",
        maxWidth: "680px",
      }}
    >
      <div
        className="rounded-2xl border px-6 py-4 text-center"
        style={{
          background:  `rgba(10,10,10,0.96)`,
          borderColor: `${currentLine.color}40`,
          boxShadow:
            `0 0 0 1px ${currentLine.color}20, ` +
            `0 8px 32px rgba(0,0,0,0.6), ` +
            `0 0 40px ${currentLine.color}18`,
          backdropFilter: "blur(12px)",
        }}
      >
        {/* Phase icon */}
        <div className="text-2xl mb-2 select-none">{currentLine.icon}</div>

        {/* Typewriter narration */}
        <div className="leading-relaxed" style={{ color: "#ddd" }}>
          <PhaseNarrator
            text           ={currentLine.text}
            charIntervalMs ={28}
            className      ="text-sm font-medium"
          />
        </div>

        {/* Subtle "narrated mode" label */}
        <div
          className="mt-2.5 text-[10px] uppercase tracking-[0.2em] font-mono"
          style={{ color: `${currentLine.color}80` }}
        >
          narrated mode · agentswap demo
        </div>
      </div>
    </div>
  );
}
