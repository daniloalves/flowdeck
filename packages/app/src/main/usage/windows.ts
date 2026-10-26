import { USAGE, type AccountUsage, type UsageWindow } from '@flowdeck/shared';
import type { UsageEntry } from './parser';

const HOUR = 60 * 60 * 1000;

export const emptyWindow = (): UsageWindow => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

function add(w: UsageWindow, e: UsageWindow): void {
  w.inputTokens += e.inputTokens;
  w.outputTokens += e.outputTokens;
  w.cacheCreationTokens += e.cacheCreationTokens;
  w.cacheReadTokens += e.cacheReadTokens;
}

/**
 * Computes the active 5-hour block (same semantics as `ccusage blocks`: a block starts at the hour
 * of its first message and lasts 5 h; a gap of 5 h also starts a new block) and the rolling
 * 7-day window. `entries` must already be deduplicated.
 */
export function computeUsage(accountId: string, entries: UsageEntry[], now: number): AccountUsage {
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const week = emptyWindow();
  const weekStart = now - USAGE.weekMs;

  let blockStart = -Infinity;
  let lastTs = -Infinity;
  let block = emptyWindow();

  for (const e of sorted) {
    if (e.timestamp > now) continue;
    if (e.timestamp >= weekStart) add(week, e);
    if (e.timestamp >= blockStart + USAGE.blockMs || e.timestamp - lastTs >= USAGE.blockMs) {
      blockStart = Math.floor(e.timestamp / HOUR) * HOUR;
      block = emptyWindow();
    }
    add(block, e);
    lastTs = e.timestamp;
  }

  const active = Number.isFinite(blockStart) && now < blockStart + USAGE.blockMs && now - lastTs < USAGE.blockMs;
  return {
    accountId,
    block: active ? { ...block, start: blockStart, end: blockStart + USAGE.blockMs } : null,
    week,
    computedAt: now,
  };
}

/** Tokens counted against the configured cap: input + output (cache traffic is shown separately). */
export const countedTokens = (w: UsageWindow): number => w.inputTokens + w.outputTokens;
