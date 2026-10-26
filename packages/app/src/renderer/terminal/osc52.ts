import { LIMITS } from '@flowdeck/shared';

/**
 * Decodes an OSC 52 "set clipboard" payload (`<targets>;<base64>`). tmux emits it when the user
 * copies (`set-clipboard external` drops programs' own OSC 52). Returns null for queries (`?`),
 * which are never answered, and for invalid or oversized payloads.
 */
export function parseOsc52(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep === -1) return null;
  const payload = data.slice(sep + 1);
  if (!payload || payload === '?' || payload.length > Math.ceil((LIMITS.clipboardChars * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text && text.length <= LIMITS.clipboardChars ? text : null;
  } catch {
    return null;
  }
}
