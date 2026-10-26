import { dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import {
  clipboardWriteSchema,
  idSchema,
  ptyInputSchema,
  ptyOpenSchema,
  ptyPasteSchema,
  ptyResizeSchema,
  ptyScrollToSchema,
  viewportSchema,
  type InvokeApi,
  type InvokeChannel,
  type Result,
} from '@flowdeck/shared';
import { z, ZodError } from 'zod';
import { preparePaste, type ClipboardLike } from './clipboard';
import type { Core } from './core';
import type { PtyBridge } from './pty/bridge';

export interface IpcDeps {
  core: Core;
  pty: PtyBridge;
  window: () => BrowserWindow | null;
  isTrustedUrl: (url: string) => boolean;
  autostart: { get(): boolean; set(enabled: boolean): boolean };
  clipboard: ClipboardLike;
}

type Handler<C extends InvokeChannel> = (
  ...args: Parameters<InvokeApi[C]>
) => ReturnType<InvokeApi[C]> | Promise<ReturnType<InvokeApi[C]>>;

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) return z.prettifyError(err);
  return err instanceof Error ? err.message : String(err);
}

/** Registers every IPC channel. Each call checks it comes from our window and validates input. */
export function registerIpc(deps: IpcDeps): void {
  const { core, pty } = deps;

  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const win = deps.window();
    const url = event.senderFrame?.url ?? '';
    return win !== null && event.sender.id === win.webContents.id && deps.isTrustedUrl(url);
  };

  function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<unknown>> => {
      if (!trusted(event)) return { ok: false, error: 'untrusted sender' };
      try {
        return { ok: true, value: await fn(...(args as Parameters<InvokeApi[C]>)) };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    });
  }

  handle('app:snapshot', () => {
    const snapshot = core.snapshot();
    return { ...snapshot, env: { ...snapshot.env, autostart: deps.autostart.get() } };
  });
  handle('node:create', (input) => core.createNode(input));
  handle('node:update', (id, patch) => core.updateNode(idSchema.parse(id), patch));
  handle('node:delete', async (id) => {
    const nodeId = idSchema.parse(id);
    pty.close(nodeId);
    await core.deleteNode(nodeId);
  });
  handle('node:restart', async (id) => {
    const nodeId = idSchema.parse(id);
    pty.close(nodeId);
    return core.restartNode(nodeId);
  });
  handle('node:duplicate', (id) => core.duplicateNode(idSchema.parse(id)));
  handle('edge:create', (input) => core.createEdge(input));
  handle('edge:delete', (id) => core.deleteEdge(idSchema.parse(id)));
  handle('annotation:create', (input) => core.createAnnotation(input));
  handle('annotation:update', (id, patch) => core.updateAnnotation(idSchema.parse(id), patch));
  handle('annotation:delete', (id) => core.deleteAnnotation(idSchema.parse(id)));
  handle('account:discover', () => core.discoverAccounts());
  handle('account:upsert', (input) => core.upsertAccount(input));
  handle('account:delete', (id) => core.deleteAccount(idSchema.parse(id)));
  handle('messages:list', () => core.listMessages());
  handle('viewport:save', (v) => core.saveViewport(viewportSchema.parse(v)));
  handle('dialog:pickDirectory', async () => {
    const win = deps.window();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('pty:scrollState', async (id) => {
    const node = core.opts.repo.getNode(idSchema.parse(id));
    return node ? core.opts.tmux.scrollState(node.tmuxSession) : null;
  });
  handle('autostart:set', (enabled) => deps.autostart.set(z.boolean().parse(enabled)));

  function on<T>(channel: string, schema: z.ZodType<T>, fn: (payload: T) => void | Promise<void>): void {
    ipcMain.on(channel, (event, payload: unknown) => {
      if (!trusted(event)) return;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return;
      Promise.resolve(fn(parsed.data)).catch(() => {
        /* PTY errors surface as pty:exit */
      });
    });
  }

  on('pty:open', ptyOpenSchema, async ({ nodeId, cols, rows }) => {
    const node = core.opts.repo.getNode(nodeId);
    if (!node) return;
    pty.open(nodeId, node.tmuxSession, cols, rows);
  });
  // Typing after scrolling back first leaves tmux's scrollback, as in a normal terminal. Input is
  // queued per node behind that, so no keystroke lands in copy mode.
  const inputQueue = new Map<string, Promise<void>>();
  on('pty:input', ptyInputSchema, ({ nodeId, data, exitScroll }) => {
    const node = exitScroll ? core.opts.repo.getNode(nodeId) : null;
    const queued = inputQueue.get(nodeId);
    if (!node && !queued) return pty.write(nodeId, data);
    const next = (queued ?? Promise.resolve()).then(async () => {
      if (node) await core.opts.tmux.leaveScrollback(node.tmuxSession).catch(() => undefined);
      pty.write(nodeId, data);
    });
    inputQueue.set(nodeId, next);
    void next.finally(() => {
      if (inputQueue.get(nodeId) === next) inputQueue.delete(nodeId);
    });
  });
  on('pty:scrollTo', ptyScrollToSchema, async ({ nodeId, lines }) => {
    const node = core.opts.repo.getNode(nodeId);
    if (node) await core.opts.tmux.scrollTo(node.tmuxSession, lines);
  });
  on('pty:resize', ptyResizeSchema, ({ nodeId, cols, rows }) => pty.resize(nodeId, cols, rows));
  on('pty:close', z.object({ nodeId: idSchema }), ({ nodeId }) => pty.close(nodeId));
  // The renderer asks for a paste but never receives the clipboard contents.
  on('pty:paste', ptyPasteSchema, async ({ nodeId, source, bracketed }) => {
    const text = await deps.clipboard.readText(source);
    if (text) pty.write(nodeId, preparePaste(text, bracketed));
  });
  on('clipboard:write', clipboardWriteSchema, async ({ text }) => {
    await deps.clipboard.writeText(text, 'selection');
    await deps.clipboard.writeText(text, 'clipboard');
  });
  on('node:focus', z.object({ nodeId: idSchema.nullable() }), ({ nodeId }) => core.setFocus(nodeId));
}
