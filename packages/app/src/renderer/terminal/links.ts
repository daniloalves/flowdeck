import { WebLinksAddon } from '@xterm/addon-web-links';
import type { IDisposable, Terminal } from '@xterm/xterm';

/** GNOME Terminal convention: Ctrl+click opens (Cmd+click on macOS); a plain click stays the terminal's. */
const wantsOpen = (e: MouseEvent): boolean => e.ctrlKey || e.metaKey;

/**
 * Makes links in a terminal open on Ctrl+click: URLs printed as text (found by xterm's web-links
 * addon) and OSC 8 hyperlinks (forwarded by tmux). The renderer never opens anything itself: it asks
 * main, which only opens web links. Hovering shows the real target, which for an OSC 8 link can
 * differ from its text.
 */
export function attachLinks(term: Terminal, el: HTMLElement, open: (url: string) => void): IDisposable {
  const hover = (_e: MouseEvent, url: string) => {
    el.title = `${url}\nCtrl+click to open`;
  };
  const leave = () => {
    el.title = '';
  };
  const activate = (e: MouseEvent, url: string) => {
    if (wantsOpen(e)) open(url);
  };
  term.options.linkHandler = { activate, hover, leave, allowNonHttpProtocols: false };
  const addon = new WebLinksAddon(activate, { hover, leave });
  term.loadAddon(addon);
  return {
    dispose: () => {
      addon.dispose();
      term.options.linkHandler = null;
      leave();
    },
  };
}
