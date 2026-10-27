import { LIMITS } from '@flowdeck/shared';

/** Opens a link outside FlowDeck (the user's browser). */
export interface LinkOpener {
  open(url: string): Promise<void>;
}

/**
 * The link to open, or null when it is not a plain web link. Terminal output is untrusted: a
 * program can print any OSC 8 target, so only http(s) is opened (never file:, javascript: or
 * schemes that start other applications), and never a URL with credentials, whose
 * `https://bank.example@evil.example` form hides the real host.
 */
export function webUrl(raw: string): string | null {
  if (raw.length > LIMITS.linkChars || /[\s\p{Cc}]/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** The desktop's default browser, through Electron (`xdg-open` on Linux, with the URL as argv). */
export function systemLinks(shell: { openExternal(url: string): Promise<void> }): LinkOpener {
  return { open: (url) => shell.openExternal(url) };
}

/** Records links instead of opening them, for tests (`FLOWDECK_TEST_LINKS=1`). */
export function memoryLinks(): LinkOpener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    open: async (url) => {
      opened.push(url);
    },
  };
}

/** Opens at most one link per `intervalMs`, so a stuck or flooded click cannot open dozens of tabs. */
export function rateLimited(opener: LinkOpener, intervalMs: number, now: () => number = Date.now): LinkOpener {
  let last = -Infinity;
  return {
    open: async (url) => {
      const t = now();
      if (t - last < intervalMs) return;
      last = t;
      await opener.open(url);
    },
  };
}
