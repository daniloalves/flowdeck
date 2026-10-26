import type { UsageWindow } from '@flowdeck/shared';

export interface UsageEntry extends UsageWindow {
  timestamp: number;
  /** `message.id:requestId`; null when the line cannot be deduplicated. */
  key: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Parses one line of a Claude Code transcript (JSONL). Returns null for anything that is not an
 * assistant message with usage. This is the only place that knows the transcript format.
 */
export function parseUsageLine(line: string): UsageEntry | null {
  // Cheap pre-filter: most lines are not assistant messages with usage.
  if (!line.includes('"usage"')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== 'assistant') return null;
  const message = rec.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const timestamp = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(timestamp)) return null;
  const messageId = typeof message?.id === 'string' ? message.id : null;
  const requestId = typeof rec.requestId === 'string' ? rec.requestId : null;
  return {
    timestamp,
    key: messageId && requestId ? `${messageId}:${requestId}` : null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}
