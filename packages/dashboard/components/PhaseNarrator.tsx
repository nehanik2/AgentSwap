"use client";

/**
 * packages/dashboard/components/PhaseNarrator.tsx
 *
 * Renders a block of narration text with a typewriter effect.
 * Each character appears after a fixed interval, simulating a "live system"
 * feel during demos.
 *
 * Usage:
 *   <PhaseNarrator text="Both chains locked. Neither party can cheat." />
 */

import { useEffect, useState } from "react";

export interface PhaseNarratorProps {
  /** Full text to reveal character by character. */
  text: string;
  /** Milliseconds between each character reveal. Default: 30. */
  charIntervalMs?: number;
  /** Additional CSS classes on the outer span. */
  className?: string;
}

export function PhaseNarrator({
  text,
  charIntervalMs = 30,
  className,
}: PhaseNarratorProps) {
  const [count, setCount] = useState(0);

  // Reset to 0 whenever text changes (new phase)
  useEffect(() => {
    setCount(0);
  }, [text]);

  // Advance one character per tick using a setTimeout chain
  useEffect(() => {
    if (count >= text.length) return;

    const timer = setTimeout(() => {
      setCount((c) => Math.min(c + 1, text.length));
    }, charIntervalMs);

    return () => clearTimeout(timer);
  }, [text, count, charIntervalMs]);

  const displayed = text.slice(0, count);
  const done      = count >= text.length;

  return (
    <span className={className}>
      {displayed}
      {/* Blinking cursor — disappears when text is fully revealed */}
      {!done && (
        <span
          className="inline-block w-[2px] h-[0.9em] ml-px align-text-bottom breathe"
          style={{ background: "currentColor" }}
        />
      )}
    </span>
  );
}
