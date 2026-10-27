import { useEffect, useRef, useState } from 'react';
import type { ScrollState } from '@flowdeck/shared';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { call, send, subscribePty } from '../api';
import { attachLinks } from './links';
import { parseOsc52 } from './osc52';
import { fixMouseScaling } from './scale';
import { Scrollbar } from './Scrollbar';

const THEME = {
  background: '#101015',
  foreground: '#e6e6ef',
  cursor: '#c9c9ff',
  selectionBackground: '#3d3d66',
};

interface Props {
  nodeId: string;
  /** Changing it re-attaches (new tmux client). */
  generation: number;
  onDetached: () => void;
}

/** Input that is not typing: mouse reports (SGR or X10) and focus in/out reports. */
const NOT_TYPING = /^(?:(?:\x1b\[<\d+;\d+;\d+[Mm])+|\x1b\[M[\s\S]{3}|\x1b\[[IO])$/;

/** FlowDeck's window shortcuts (see App.tsx) never reach the program in the terminal. */
const isWindowShortcut = (e: KeyboardEvent): boolean => e.ctrlKey && e.shiftKey && /^[ndgxl]$/i.test(e.key);

/**
 * xterm.js view of one node. It is only a client: closing it detaches from tmux, the program
 * inside keeps running. Uses the DOM renderer, which stays crisp when the canvas is zoomed and
 * has no WebGL context limit.
 */
export function Terminal({ nodeId, generation, onDetached }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onDetachedRef = useRef(onDetached);
  onDetachedRef.current = onDetached;
  const [scroll, setScroll] = useState<ScrollState | null>(null);
  const scrollTo = useRef<(lines: number) => void>(() => undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "Fira Code", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      theme: THEME,
      scrollback: 2000,
      cursorBlink: true,
      allowProposedApi: false,
      macOptionIsMeta: true,
    });
    const paste = (source: 'selection' | 'clipboard') =>
      send('pty:paste', { nodeId, source, bracketed: term.modes.bracketedPasteMode });
    const copy = (text: string) => {
      if (text) send('clipboard:write', { text });
    };

    // GNOME Terminal keys: Ctrl+Shift+C copies, Ctrl+Shift+V pastes the clipboard.
    term.attachCustomKeyEventHandler((e) => {
      if (isWindowShortcut(e)) return false;
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || !/^[cv]$/i.test(e.key)) return true;
      e.preventDefault(); // no native paste into xterm's textarea (it would paste twice)
      if (e.type === 'keydown' && !e.repeat) {
        if (e.key.toLowerCase() === 'v') paste('clipboard');
        else copy(term.getSelection());
      }
      return false;
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fixMouseScaling(term);
    const links = attachLinks(term, el, (url) => send('link:open', { url }));
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }

    const unsubscribe = subscribePty(nodeId, {
      data: (d) => term.write(d),
      exit: () => onDetachedRef.current(),
    });
    send('pty:open', { nodeId, cols: Math.max(term.cols, 2), rows: Math.max(term.rows, 2) });

    // Scrollback lives in tmux (copy mode). The scrollbar follows it after each wheel turn, and the
    // first keystroke after scrolling back leaves it, like a normal terminal.
    let scrolledBack = false;
    let refreshTimers: number[] = [];
    const refreshScroll = () => {
      refreshTimers.forEach((t) => window.clearTimeout(t));
      // tmux applies the wheel asynchronously: read now and once more shortly after.
      refreshTimers = [60, 300].map((ms) =>
        window.setTimeout(() => {
          call('pty:scrollState', nodeId)
            .then((st) => {
              if (st?.inMode) scrolledBack = true;
              setScroll(st);
            })
            .catch(() => undefined);
        }, ms),
      );
    };
    const onWheel = () => {
      scrolledBack = true;
      refreshScroll();
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: true });

    let scrollTimer = 0;
    let pendingLines: number | null = null;
    scrollTo.current = (lines) => {
      scrolledBack = lines > 0;
      setScroll((st) => (st ? { ...st, position: lines, inMode: lines > 0 } : st));
      pendingLines = lines;
      if (scrollTimer) return; // at most one tmux call per 50 ms while dragging
      scrollTimer = window.setTimeout(() => {
        scrollTimer = 0;
        if (pendingLines !== null) send('pty:scrollTo', { nodeId, lines: pendingLines });
        pendingLines = null;
        refreshScroll();
      }, 50);
    };

    const input = term.onData((data) => {
      const typing = !NOT_TYPING.test(data);
      send('pty:input', { nodeId, data, ...(typing && scrolledBack ? { exitScroll: true } : {}) });
      if (typing && scrolledBack) {
        scrolledBack = false;
        setScroll(null);
      }
    });

    // Selecting copies: tmux copies on mouse release and announces it with OSC 52; Shift+drag
    // (xterm's own selection) is copied once the selection settles.
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data);
      if (text) copy(text);
      return true;
    });
    let selectionTimer = 0;
    const selection = term.onSelectionChange(() => {
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => copy(term.getSelection()), 200);
    });

    // Middle click pastes the PRIMARY selection (Ubuntu). It is stopped before xterm reports it
    // to tmux and before Chromium does its own PRIMARY paste.
    const onMiddle = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'mousedown') {
        term.focus();
        paste('selection');
      }
    };
    for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) el.addEventListener(type, onMiddle, true);
    const resize = term.onResize(({ cols, rows }) => send('pty:resize', { nodeId, cols, rows }));

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
    });
    observer.observe(el);

    const textarea = term.textarea;
    const onFocus = () => send('node:focus', { nodeId });
    const onBlur = () => send('node:focus', { nodeId: null });
    textarea?.addEventListener('focus', onFocus);
    textarea?.addEventListener('blur', onBlur);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(selectionTimer);
      window.clearTimeout(scrollTimer);
      refreshTimers.forEach((t) => window.clearTimeout(t));
      el.removeEventListener('wheel', onWheel, { capture: true });
      for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) el.removeEventListener(type, onMiddle, true);
      osc52.dispose();
      links.dispose();
      selection.dispose();
      observer.disconnect();
      textarea?.removeEventListener('focus', onFocus);
      textarea?.removeEventListener('blur', onBlur);
      input.dispose();
      resize.dispose();
      unsubscribe();
      send('pty:close', { nodeId });
      term.dispose();
    };
  }, [nodeId, generation]);

  return (
    <>
      <div ref={host} className="fd-terminal nodrag nowheel nopan" data-testid={`terminal-${nodeId}`} />
      <Scrollbar state={scroll} onScrollTo={(lines) => scrollTo.current(lines)} />
    </>
  );
}
