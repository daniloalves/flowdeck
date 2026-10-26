/**
 * Makes untrusted agent text safe to type into a terminal:
 * - drops C0/C1 control characters and DEL, so no escape sequence can reach the terminal;
 * - drops invisible format characters (zero-width, bidi overrides, Unicode tags), so nothing can
 *   be hidden from the user reading the log;
 * - folds the text into a single line: a pasted newline could otherwise submit early when bracketed
 *   paste is off, and a line starting with `!` would run a shell command in Claude Code.
 */
export function sanitizeForTerminal(input: string): string {
  return (
    input
      .replace(/\r\n?|[\n\u2028\u2029\u0085]/g, ' \u23CE ')
      .replace(/\t/g, '  ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\p{Cf}/gu, '')
      .replace(/ {3,}/g, '  ')
      .trim()
  );
}

/** Neutralises an origin header inside a body, so a sender cannot impersonate another node. */
const neutraliseHeaders = (body: string): string => body.replace(/\[(\s*from\s*:)/gi, '($1');

/** Text typed into the receiving node: one line per message, each prefixed with its origin. */
export function formatDelivery(messages: { fromTitle: string; body: string }[]): string {
  return messages
    .map((m) => `[from: ${sanitizeForTerminal(m.fromTitle)}] ${neutraliseHeaders(sanitizeForTerminal(m.body))}`)
    .join(' \u23CE ');
}
