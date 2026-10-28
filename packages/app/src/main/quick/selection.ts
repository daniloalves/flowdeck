import { LIMITS, type SelectionSource } from '@flowdeck/shared';
import type { ClipboardLike } from '../clipboard';

export interface Selection {
  text: string;
  source: SelectionSource;
  truncated: boolean;
}

/**
 * Selected text as a task can carry it: CRLF becomes LF, other control characters (escape
 * sequences, NUL…) are dropped, and it is cut at `LIMITS.selectionChars`.
 */
export function normalizeSelection(raw: string): Omit<Selection, 'source'> {
  const cleaned = raw.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]/gu, '');
  const truncated = cleaned.length > LIMITS.selectionChars;
  return { text: (truncated ? cleaned.slice(0, LIMITS.selectionChars) : cleaned).trim(), truncated };
}

/**
 * The text a quick launch starts from: the current selection (X11 PRIMARY, set by selecting text
 * in any app), else the clipboard. Read only when the user asks for a quick launch.
 */
export async function readSelection(clipboard: ClipboardLike): Promise<Selection> {
  for (const source of ['selection', 'clipboard'] as const) {
    const read = normalizeSelection(await clipboard.readText(source).catch(() => ''));
    if (read.text) return { ...read, source };
  }
  return { text: '', source: 'none', truncated: false };
}

/** `flowdeck --quick-launch` (for a desktop shortcut, e.g. on Wayland or when FlowDeck is closed). */
export const wantsQuickLaunch = (argv: readonly string[]): boolean => argv.includes('--quick-launch');

/** System-wide keyboard shortcuts. */
export interface ShortcutRegistry {
  /** False when the shortcut could not be registered. */
  register(accelerator: string, onPress: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Electron's global shortcuts. On X11 they grab the key on the X server; `register` still reports
 * success when another program owns the key, so a conflict cannot be detected here.
 */
export function systemShortcuts(globalShortcut: {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}): ShortcutRegistry {
  return {
    register: (accelerator, onPress) => {
      try {
        return globalShortcut.register(accelerator, onPress);
      } catch {
        return false;
      }
    },
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
  };
}

/** Shortcuts that never grab a real key, for tests (`FLOWDECK_TEST_SHORTCUTS=1`); `press` fires one. */
export function memoryShortcuts(): ShortcutRegistry & { registered(): string[]; press(accelerator: string): boolean } {
  const handlers = new Map<string, () => void>();
  return {
    register: (accelerator, onPress) => {
      handlers.set(accelerator, onPress);
      return true;
    },
    unregister: (accelerator) => {
      handlers.delete(accelerator);
    },
    registered: () => [...handlers.keys()],
    press: (accelerator) => {
      const handler = handlers.get(accelerator);
      handler?.();
      return handler !== undefined;
    },
  };
}
