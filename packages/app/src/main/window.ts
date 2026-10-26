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
  const dev = devServerUrl();
  if (dev) void win.loadURL(dev);
  else void win.loadFile(rendererFile());
  return win;
}
