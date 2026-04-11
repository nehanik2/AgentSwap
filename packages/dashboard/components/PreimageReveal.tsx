"use client";

/**
 * packages/dashboard/components/PreimageReveal.tsx
 *
 * Cinematic full-width banner that fires when settlement is confirmed.
 * The preimage hex string is revealed one character at a time (50 ms/char),
 * then the whole banner fades out after 5 seconds.
 *
 * Non-blocking: positioned as a fixed overlay below the header (z-40),
 * so the agent panels remain interactive underneath it.
 */

import { useEffect, useRef, useState } from "react";

export interface PreimageRevealProps {
  /** The raw 32-byte preimage as a hex string (64 chars, no 0x prefix) */
  preimageHex: string;
  /** Controls mount/unmount of the animation */
  visible: boolean;
  /** Called after the banner fully fades out */
  onDismiss: () => void;
}

const CHAR_INTERVAL_MS = 50;
const HOLD_MS          = 3_000; // how long to show fully-revealed preimage
const FADE_MS          = 600;   // CSS fade-out duration

export function PreimageReveal({ preimageHex, visible, onDismiss }: PreimageRevealProps) {
  const [revealedCount, setRevealedCount] = useState(0);
  const [fading,        setFading]        = useState(false);
  const onDismissRef = useRef(onDismiss);

  // Keep ref in sync so the timer closure never captures a stale callback
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  useEffect(() => {
    if (!visible) {
      setRevealedCount(0);
      setFading(false);
      return;
    }

    const charTotal = preimageHex.length;
    let count       = 0;
    let holdTimer:   ReturnType<typeof setTimeout> | null = null;
    let fadeTimer:   ReturnType<typeof setTimeout> | null = null;

    // Reveal one character per tick
    const revealTimer = setInterval(() => {
      count += 1;
      setRevealedCount(count);

      if (count >= charTotal) {
        clearInterval(revealTimer);

        // Hold fully revealed, then fade out
        holdTimer = setTimeout(() => {
          setFading(true);
          fadeTimer = setTimeout(() => { onDismissRef.current(); }, FADE_MS);
        }, HOLD_MS);
      }
    }, CHAR_INTERVAL_MS);

    return () => {
      clearInterval(revealTimer);
      if (holdTimer) clearTimeout(holdTimer);
      if (fadeTimer) clearTimeout(fadeTimer);
    };
  }, [visible, preimageHex]);

  if (!visible) return null;

  const total    = preimageHex.length;
  const revealed = preimageHex.slice(0, revealedCount);
  const pending  = preimageHex.slice(revealedCount);
  const pct      = total > 0 ? Math.round((revealedCount / total) * 100) : 0;

  return (
    <div
      className="fixed left-0 right-0 z-40 preimage-reveal-in"
      style={{
        top:        "41px", // header height — sits flush below header bar
        opacity:    fading ? 0 : 1,
        transition: fading ? `opacity ${FADE_MS}ms ease-in` : "none",
        pointerEvents: fading ? "none" : "auto",
      }}
    >
      <div
        className="relative overflow-hidden border-b"
        style={{
          background:  "rgba(10, 10, 10, 0.97)",
          borderColor: "rgba(34,197,94,0.35)",
          boxShadow:   "0 4px 32px rgba(34,197,94,0.15), 0 0 0 1px rgba(34,197,94,0.1)",
        }}
      >
        {/* Scanning progress line */}
        <div
          className="absolute bottom-0 left-0 h-px transition-all duration-75"
          style={{
            width:      `${pct}%`,
            background: "linear-gradient(90deg, rgba(34,197,94,0.6), #22c55e, rgba(34,197,94,0.4))",
            boxShadow:  "0 0 8px #22c55e",
          }}
        />

        <div className="px-5 py-3 flex items-start gap-6">
          {/* Left: label column */}
          <div className="flex-shrink-0 flex flex-col gap-1 pt-0.5">
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full flex-shrink-0"
                style={{ background: "#22c55e", boxShadow: "0 0 6px #22c55e" }}
              />
              <span className="text-[10px] uppercase tracking-[0.2em] font-semibold" style={{ color: "#22c55e" }}>
                Preimage Revealed
              </span>
            </div>
            <div className="text-[10px] text-[#555] leading-snug pl-4 max-w-[180px]">
              BTC &amp; ETH unlocked simultaneously
            </div>
            <div className="text-[10px] font-mono pl-4 mt-1" style={{ color: "#444" }}>
              {pct < 100
                ? `revealing… ${pct}%`
                : "✓ both chains unlocked"}
            </div>
          </div>

          {/* Right: monospace hex display */}
          <div className="flex-1 min-w-0">
            <div className="stat-mono text-sm leading-relaxed break-all select-all">
              <span style={{ color: "#22c55e" }}>{revealed}</span>
              <span
                className="inline-block w-[7px] h-[14px] ml-px align-middle"
                style={{
                  background: revealedCount < total ? "#22c55e" : "transparent",
                  animation:  revealedCount < total ? "breathe 0.6s ease-in-out infinite" : "none",
                  boxShadow:  revealedCount < total ? "0 0 6px #22c55e" : "none",
                }}
              />
              <span style={{ color: "#1a1a1a" }}>{pending}</span>
            </div>

            {/* 32-byte / 256-bit label */}
            <div className="mt-1.5 flex items-center gap-3 text-[10px] text-[#333] font-mono">
              <span>32 bytes · 256-bit secret</span>
              {revealedCount >= total && (
                <span
                  className="badge-pop px-2 py-0.5 rounded-full"
                  style={{
                    color:      "#22c55e",
                    background: "rgba(34,197,94,0.1)",
                    border:     "1px solid rgba(34,197,94,0.3)",
                  }}
                >
                  Hash-locked · trustless · final
                </span>
              )}
            </div>
          </div>

          {/* Progress fraction */}
          <div className="flex-shrink-0 text-right pt-0.5">
            <div className="stat-mono text-lg font-black" style={{ color: "#22c55e" }}>
              {pct}
              <span className="text-[10px] font-normal text-[#333] ml-0.5">%</span>
            </div>
            <div className="text-[10px] text-[#333] font-mono">{revealedCount}/{total}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
