import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Notification, session } from 'electron';
import type { EventApi, EventChannel } from '@flowdeck/shared';
import { autostartFile, isAutostartEnabled, setAutostart } from './autostart';
import { memoryClipboard, systemClipboard, type ClipboardLike } from './clipboard';
import { AGENT_KINDS } from '@flowdeck/shared';
import { AGENTS, binOverrideVar } from './agents';
import { Core } from './core';
import { openDatabase, type Db } from './db/database';
import { Repo } from './db/repo';
import { registerIpc } from './ipc';
import { PtyBridge } from './pty/bridge';
import { ensurePrivateDir, installRuntimeFiles, resolveRuntime } from './runtime';
import { loginShellPath, mergePath, which } from './shellenv';
import { sanitizeEnv } from './tmux/env';
import { Tmux } from './tmux/tmux';
import { createMainWindow, isTrustedUrl } from './window';

const runtime = resolveRuntime(process.env);
// Keep Chromium's profile inside FlowDeck's data dir (also isolates test runs).
app.setPath('userData', join(runtime.paths.dataDir, 'electron'));
app.setName('FlowDeck');

let mainWindow: BrowserWindow | null = null;
let core: Core | null = null;
let ptyBridge: PtyBridge | null = null;
let db: Db | null = null;

function emit<C extends EventChannel>(channel: C, payload: EventApi[C]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function lockDownSessions(): void {
  const ses = session.defaultSession;
  // No outbound network: only the app's own files (and the dev server in development).
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isTrustedUrl(details.url) && !details.url.startsWith('devtools://') });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** The system clipboard, or an in-memory one for E2E tests (exposed to Playwright on globalThis). */
function appClipboard(): ClipboardLike {
  if (!process.env.FLOWDECK_TEST_CLIPBOARD) return systemClipboard(clipboard);
  const memory = memoryClipboard();
  (globalThis as { __flowdeckClipboard?: typeof memory.contents }).__flowdeckClipboard = memory.contents;
  return memory;
}

async function bootstrap(): Promise<void> {
  const { paths, home } = runtime;
  ensurePrivateDir(paths.dataDir);

  const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources');
  const mcpSource = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'flowdeck-mcp.cjs')
    : join(app.getAppPath(), '..', 'mcp', 'dist', 'flowdeck-mcp.cjs');
  installRuntimeFiles(paths, resourcesDir, mcpSource);

  const shellBin = process.env.SHELL || '/bin/bash';
  const shellPath = process.env.FLOWDECK_SKIP_SHELL_ENV ? null : await loginShellPath(shellBin);
  // macOS apps started from Finder do not get Homebrew's directories either.
  const brew = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  const PATH = mergePath(process.env.PATH, shellPath, join(home, '.local', 'bin'), ...brew);
  const tmuxBin = which(runtime.tmuxBin, PATH) ?? runtime.tmuxBin;
  const agentBins = Object.fromEntries(
    AGENT_KINDS.map((kind) => [kind, which(process.env[binOverrideVar(kind)] ?? AGENTS[kind].bin, PATH)]),
  );

  const tmux = new Tmux({
    bin: tmuxBin,
    socket: runtime.tmuxSocket,
    confFile: paths.tmuxConf,
    env: sanitizeEnv(process.env, { PATH }),
  });

  db = openDatabase(paths.dbFile);
  const repo = new Repo(db);

  // In an AppImage, process.execPath lives in a mount that changes on every run.
  const mcpCommand = process.env.APPIMAGE ?? process.execPath;

  core = new Core({
    repo,
    tmux,
    paths,
    home,
    agentBins,
    shellBin,
    mcpRunner: { command: mcpCommand, args: [paths.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1' } },
    emit,
    isAppFocused: () => mainWindow?.isFocused() ?? false,
    notifier: {
      notify(title, body, nodeId) {
        if (process.env.FLOWDECK_DISABLE_NOTIFICATIONS || !Notification.isSupported()) return;
        const n = new Notification({ title, body, silent: false });
        n.on('click', () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
          emit('ui:focusNode', { nodeId });
        });
        n.show();
      },
    },
  });
  core.pruneNodeDirs();

  ptyBridge = new PtyBridge(tmux, {
    data: (nodeId, data) => emit('pty:data', { nodeId, data }),
    exit: (nodeId) => emit('pty:exit', { nodeId }),
  });

  const autostartPath = autostartFile(home, process.env.XDG_CONFIG_HOME);
  const autostartExec = process.env.APPIMAGE
    ? [process.env.APPIMAGE]
    : app.isPackaged
      ? [process.execPath]
      : [process.execPath, app.getAppPath()];

  // macOS has login items; Linux desktops read ~/.config/autostart.
  const autostart =
    process.platform === 'darwin'
      ? {
          get: () => app.getLoginItemSettings().openAtLogin,
          set: (enabled: boolean) => {
            app.setLoginItemSettings({ openAtLogin: enabled });
            return app.getLoginItemSettings().openAtLogin;
          },
        }
      : {
          get: () => isAutostartEnabled(autostartPath),
          set: (enabled: boolean) => setAutostart(autostartPath, enabled, autostartExec),
        };

  registerIpc({
    core,
    pty: ptyBridge,
    clipboard: appClipboard(),
    window: () => mainWindow,
    isTrustedUrl,
    autostart,
  });

  await core.start();
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    lockDownSessions();
    try {
      await bootstrap();
    } catch (err) {
      dialog.showErrorBox('FlowDeck could not start', err instanceof Error ? err.message : String(err));
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());

  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopping || !core) return;
    stopping = true;
    event.preventDefault();
    // Only FlowDeck's own services stop; the tmux sessions keep running.
    ptyBridge?.closeAll();
    core
      .stop()
      .catch(() => undefined)
      .finally(() => {
        db?.close();
        app.quit();
      });
  });
}
