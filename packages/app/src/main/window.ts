import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';

const devServerUrl = (): string | null => process.env.ELECTRON_RENDERER_URL ?? null;
const rendererFile = (): string => join(__dirname, '../renderer/index.html');

/** URLs the renderer is allowed to load: the bundled files, or the local dev server in development. */
export function isTrustedUrl(url: string): boolean {
  const dev = devServerUrl();
  if (dev) {
    try {
      if (new URL(url).origin === new URL(dev).origin) return true;
    } catch {
      return false;
    }
  }
  if (!url.startsWith('file://')) return false;
  const root = pathToFileURL(join(__dirname, '../renderer')).href;
  return url.startsWith(`${root}/`);
}

/** The hardening every FlowDeck window gets. Exported so tests can assert on it. */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  backgroundThrottling: false,
} as const;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'FlowDeck',
    backgroundColor: '#14141a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: join(__dirname, '../preload/index.js') },
  });
  if (!process.env.FLOWDECK_HIDE_WINDOW) win.once('ready-to-show', () => win.show());
  loadRenderer(win);
  return win;
}

/** The quick-launch window: the same renderer bundle, opened as `#quick`. Shown on demand. */
export function createQuickWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 620,
    title: 'FlowDeck — Quick launch',
    backgroundColor: '#1c1c24',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: join(__dirname, '../preload/index.js') },
  });
  loadRenderer(win, 'quick');
  return win;
}

function loadRenderer(win: BrowserWindow, hash?: string): void {
  const dev = devServerUrl();
  if (dev) void win.loadURL(hash ? `${dev}#${hash}` : dev);
  else void win.loadFile(rendererFile(), hash ? { hash } : {});
}
