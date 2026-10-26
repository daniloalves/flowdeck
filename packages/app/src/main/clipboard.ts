import type { Clipboard } from 'electron';
import { LIMITS } from '@flowdeck/shared';

export type ClipboardSource = 'selection' | 'clipboard';

/** Text clipboard access; 'selection' is the X11 PRIMARY selection (middle click). */
export interface ClipboardLike {
  readText(source: ClipboardSource): Promise<string>;
  writeText(text: string, source: ClipboardSource): Promise<void>;
}

/** Electron's clipboard. PRIMARY only exists on Linux; elsewhere it reads empty and ignores writes. */
export function systemClipboard(clipboard: Clipboard): ClipboardLike {
  const target = (source: ClipboardSource): Clipboard | undefined =>
    source === 'selection' ? clipboard.selection : clipboard;
  return {
    readText: async (source) => (await target(source)?.readText()) ?? '',
    writeText: async (text, source) => {
      await target(source)?.writeText(text);
    },
  };
}

/** In-memory clipboard for tests (`FLOWDECK_TEST_CLIPBOARD=1`), so they never touch the user's. */
export function memoryClipboard(): ClipboardLike & { contents: Record<ClipboardSource, string> } {
  const contents: Record<ClipboardSource, string> = { selection: '', clipboard: '' };
  return {
    contents,
    readText: async (source) => contents[source],
    writeText: async (text, source) => {
      contents[source] = text;
    },
  };
}

const BRACKET_START = '\x1b[200~';
const BRACKET_END = '\x1b[201~';

/**
 * Text as a terminal paste: line breaks become CR (what Enter sends) and, when the program enabled
 * bracketed paste, the text is wrapped in markers. Markers inside the text are removed first, so a
 * crafted clipboard cannot end the paste early and have the rest run as typed input.
 */
export function preparePaste(text: string, bracketed: boolean): string {
  let body = text.slice(0, LIMITS.clipboardChars).replace(/\r?\n/g, '\r');
  if (!bracketed) return body;
  // Repeat until stable: removing one marker can join two halves into a new one.
  for (let prev = ''; prev !== body; ) {
    prev = body;
    body = body.split(BRACKET_END).join('').split(BRACKET_START).join('');
  }
  return `${BRACKET_START}${body}${BRACKET_END}`;
}
