import { screen, type BrowserWindow } from 'electron';
import { quickLaunchSchema, type EventApi, type EventChannel, type NodeView, type QuickLaunchState } from '@flowdeck/shared';
import type { ClipboardLike } from '../clipboard';
import type { Core } from '../core';
import { createQuickWindow } from '../window';
import { readSelection, type ShortcutRegistry } from './selection';

export interface QuickLaunchDeps {
  core: Core;
  clipboard: ClipboardLike;
  shortcuts: ShortcutRegistry;
  mainWindow: () => BrowserWindow | null;
  /** Events for the main window. */
  emit: <C extends EventChannel>(channel: C, payload: EventApi[C]) => void;
  notify: (title: string, body: string, nodeId: string) => void;
  /** Never show the window (tests drive it hidden). */
  hidden: boolean;
}

/**
 * Quick launch: a global shortcut opens a small window near the pointer with the text selected in
 * any app and FlowDeck's templates. The window is created on first use and then only hidden.
 */
export class QuickLaunch {
  private win: BrowserWindow | null = null;
  private pending: QuickLaunchState | null = null;
  private shortcut = '';
  private launching = false;

  constructor(private readonly deps: QuickLaunchDeps) {}

  get window(): BrowserWindow | null {
    return this.win;
  }

  /** The shortcut is registered. */
  get active(): boolean {
    return this.shortcut !== '';
  }

  /** What the window shows; null while it is closed. */
  state(): QuickLaunchState | null {
    return this.pending;
  }

  /** Registers `accelerator` as the shortcut ('' turns it off). Returns whether one is active. */
  setShortcut(accelerator: string): boolean {
    if (this.shortcut) this.deps.shortcuts.unregister(this.shortcut);
    this.shortcut = '';
    if (accelerator && this.deps.shortcuts.register(accelerator, () => void this.open())) this.shortcut = accelerator;
    return this.active;
  }

  /** Reads the selection (only now) and opens the window with it. */
  async open(): Promise<void> {
    const { core } = this.deps;
    const selection = await readSelection(this.deps.clipboard);
    this.pending = {
      ...selection,
      templates: core.describeTemplates(),
      groups: core.groups(),
      afterLaunch: core.settings().quickLaunch.afterLaunch,
    };
    const win = this.ensureWindow();
    // A window still loading asks for the state itself (`quick:state`) once it is up.
    if (!win.webContents.isLoading()) win.webContents.send('quick:show', this.pending);
    if (this.deps.hidden) return;
    placeNearPointer(win);
    win.show();
    win.focus();
  }

  close(): void {
    this.pending = null;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  async launch(raw: unknown): Promise<NodeView> {
    if (!this.pending) throw new Error('the quick launch window is closed');
    const input = quickLaunchSchema.parse(raw);
    const { core } = this.deps;
    const main = this.deps.mainWindow();
    const center = viewCenter(main, core.opts.repo.getViewport());
    this.launching = true;
    let node: NodeView;
    try {
      node = await core.launchTemplate({ ...input, ...(center ? { center } : {}) });
    } finally {
      this.launching = false;
    }
    this.close();
    if (core.settings().quickLaunch.afterLaunch === 'flowdeck' && main) {
      if (main.isMinimized()) main.restore();
      if (!this.deps.hidden) main.show();
      main.focus();
      this.deps.emit('ui:focusNode', { nodeId: node.id });
    } else {
      this.deps.notify(`Launched “${node.title}”`, 'Click to show it in FlowDeck.', node.id);
    }
    return node;
  }

  /** With the main window gone FlowDeck quits, so this window goes too. */
  destroy(): void {
    this.pending = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = createQuickWindow();
    // Clicking another window closes it, like a menu (not while a launch is under way).
    win.on('blur', () => {
      if (!this.launching && !this.deps.hidden) this.close();
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.pending = null;
    });
    this.win = win;
    return win;
  }
}

/** Centre of the visible canvas in canvas coordinates, from the saved viewport. */
function viewCenter(main: BrowserWindow | null, viewport: { x: number; y: number; zoom: number } | null): { x: number; y: number } | null {
  if (!main || !viewport) return null;
  const [w = 0, h = 0] = main.getContentSize();
  return { x: (w / 2 - viewport.x) / viewport.zoom, y: (h / 2 - viewport.y) / viewport.zoom };
}

/** Below the pointer (above it near the bottom of the screen), kept on the pointer's display. */
function placeNearPointer(win: BrowserWindow): void {
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).workArea;
  const [w = 0, h = 0] = win.getSize();
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
  const below = p.y + 16;
  const y = below + h <= area.y + area.height ? below : p.y - h - 16;
  win.setPosition(Math.round(clamp(p.x - w / 2, area.x, area.x + area.width - w)), Math.round(clamp(y, area.y, area.y + area.height - h)));
}
