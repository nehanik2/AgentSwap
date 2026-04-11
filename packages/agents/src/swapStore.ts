/**
 * packages/agents/src/swapStore.ts
 *
 * In-memory store for CoordinatorSwapRecord.
 *
 * Not persistent across restarts — the dashboard has its own persistent-ish
 * store (packages/dashboard/lib/store.ts). This one is purely for the
 * coordinator to track in-flight swaps within a single process lifetime.
 */

import type { CoordinatorSwapRecord } from "./types.js";

export class SwapStore {
  private readonly records = new Map<string, CoordinatorSwapRecord>();

  // ── Write ──────────────────────────────────────────────────────────────────

  /** Insert or fully replace a record. */
  set(swapId: string, record: CoordinatorSwapRecord): void {
    this.records.set(swapId, record);
  }

  /**
   * Shallow-merge a partial update into an existing record.
   * Throws if the swapId is unknown — callers must call set() first.
   */
  update(swapId: string, patch: Partial<CoordinatorSwapRecord>): CoordinatorSwapRecord {
    const existing = this.records.get(swapId);
    if (!existing) {
      throw new Error(`SwapStore: unknown swapId "${swapId}"`);
    }
    const updated: CoordinatorSwapRecord = { ...existing, ...patch };
    this.records.set(swapId, updated);
    return updated;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** Returns the record for the given swapId, or undefined if not found. */
  get(swapId: string): CoordinatorSwapRecord | undefined {
    return this.records.get(swapId);
  }

  /**
   * Returns the record for the given swapId.
   * Throws a descriptive error if not found — use this inside coordinator
   * methods where a missing record is always a programming error.
   */
  getOrThrow(swapId: string): CoordinatorSwapRecord {
    const record = this.records.get(swapId);
    if (!record) {
      throw new Error(`SwapStore: swap "${swapId}" not found`);
    }
    return record;
  }

  /** Returns a snapshot of all records as an array (insertion order). */
  getAll(): CoordinatorSwapRecord[] {
    return Array.from(this.records.values());
  }

  /** Returns the number of tracked swaps. */
  get size(): number {
    return this.records.size;
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  /** Returns true if the store contains a record for the given swapId. */
  has(swapId: string): boolean {
    return this.records.has(swapId);
  }

  /**
   * Remove a record permanently.
   * Use with caution — only for cleaning up test fixtures.
   */
  delete(swapId: string): boolean {
    return this.records.delete(swapId);
  }
}
