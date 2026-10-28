import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const APP_DIR = resolve(__dirname, '../..');
const fixture = (name: string) => join(APP_DIR, 'tests/fixtures', name);
const root = mkdtempSync(join(tmpdir(), 'fdql-'));
const home = join(root, 'home');
const project = join(home, 'project');
const tmuxSocket = `fdql-${process.pid}`;
for (const d of ['.claude', 'project']) mkdirSync(join(home, d), { recursive: true });

type UntypedInvoke = (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; value?: unknown }>;
type Rect = { x: number; y: number; w: number; h: number };
type Snap = {
  nodes: (Rect & { id: string; title: string; tmuxSession: string; dangerous: boolean })[];
  annotations: (Rect & { id: string })[];
  templates: { id: string; name: string; task: string }[];
  settings: { quickLaunch: { shortcut: string; afterLaunch: string } };
};
type Shortcuts = { registered(): string[]; press(accelerator: string): boolean };
type TestGlobals = { __flowdeckShortcuts: Shortcuts; __flowdeckClipboard: Record<'selection' | 'clipboard', string> };

let app: ElectronApplication;
let page: Page;
const ids: Record<string, string> = {};

async function invokeOn<T>(p: Page, channel: string, ...args: unknown[]): Promise<{ ok: boolean; error?: string; value?: T }> {
  return p.evaluate(([c, a]) => (window.flowdeck.invoke as unknown as UntypedInvoke)(c, ...a), [channel, args] as const) as Promise<{
    ok: boolean;
    error?: string;
    value?: T;
  }>;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await invokeOn<T>(page, channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}

const snapshot = () => invoke<Snap>('app:snapshot');
const screenOf = (session: string) => execFileSync('tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-t', session], { encoding: 'utf8' });
const inside = (r: Rect, g: Rect) => r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h;

const registered = () => app.evaluate(() => (globalThis as unknown as TestGlobals).__flowdeckShortcuts.registered());
const setClipboard = (selection: string, clipboard = '') =>
  app.evaluate(
    (_e, [s, c]) => {
      const g = (globalThis as unknown as TestGlobals).__flowdeckClipboard;
      g.selection = s;
      g.clipboard = c;
    },
    [selection, clipboard] as const,
  );

/** Presses the global shortcut (the test registry never grabs a real key) and returns the window. */
async function pressShortcut(accelerator = 'Control+Alt+F'): Promise<Page> {
  expect(await app.evaluate((_e, a) => (globalThis as unknown as TestGlobals).__flowdeckShortcuts.press(a), accelerator)).toBe(true);
  let quick: Page | undefined;
  await expect.poll(() => (quick = app.windows().find((w) => w.url().endsWith('#quick')))).toBeTruthy();
  await quick!.getByTestId('quick-launch').waitFor();
  return quick!;
}

test.describe.serial('Quick launch from any window', () => {
  test.beforeAll(async () => {
    app = await electron.launch({
      args: [APP_DIR],
      env: {
        PATH: process.env.PATH ?? '',
        DISPLAY: process.env.DISPLAY ?? ':0',
        HOME: home,
        SHELL: '/bin/bash',
        LANG: 'C.UTF-8',
        FLOWDECK_DATA_DIR: join(root, 'data'),
        FLOWDECK_SOCK_PATH: join(root, 'fd.sock'),
        FLOWDECK_TMUX_SOCKET: tmuxSocket,
        FLOWDECK_CLAUDE_BIN: fixture('fake-claude.sh'),
        FLOWDECK_CODEX_BIN: fixture('fake-codex.sh'),
        FLOWDECK_KIRO_BIN: fixture('fake-kiro.sh'),
        FLOWDECK_SKIP_SHELL_ENV: '1',
        FLOWDECK_HIDE_WINDOW: '1',
        FLOWDECK_DISABLE_NOTIFICATIONS: '1',
        FLOWDECK_TEST_CLIPBOARD: '1',
        FLOWDECK_TEST_SHORTCUTS: '1',
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.fd-toolbar');
    await invoke('account:upsert', { id: 'default', label: 'Claude main', configDir: join(home, '.claude'), color: '#7c6cf2' });
    const base = { kind: 'claude', cwd: project, accountId: 'default', w: 400, h: 260 };
    ids.fixer = (await invoke<{ id: string }>('template:create', { ...base, name: 'Fixer', title: 'fixer', task: 'Investigate this error:\n{{selection}}' })).id;
    ids.danger = (await invoke<{ id: string }>('template:create', { ...base, name: 'YOLO', title: 'yolo', launchArgs: ['--dangerously-skip-permissions'] })).id;
    ids.group = (await invoke<{ id: string }>('annotation:create', { kind: 'group', text: 'Bugs', color: '#ff4d5e', x: 3000, y: 3000, w: 500, h: 400 })).id;
    await page.reload();
    await page.waitForSelector('.fd-toolbar');
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'kill-server']);
    } catch {
      /* not running */
    }
    rmSync(join('/tmp', `tmux-${process.getuid?.() ?? 0}`, tmuxSocket), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test('Ctrl+Alt+F is registered by default and shown in the Launch panel', async () => {
    expect(await registered()).toEqual(['Control+Alt+F']);
    await page.getByTestId('toggle-launch').click();
    await expect(page.getByTestId('quick-shortcut')).toHaveText('Ctrl+Alt+F');
    await expect(page.getByTestId('quick-shortcut-state')).toHaveText('on');
  });

  test('the selected text launches a task from the quick window, into the chosen group', async () => {
    await setClipboard('TypeError: boom\r\nat line 3', 'not this');
    const quick = await pressShortcut();
    await expect(quick.getByTestId('quick-source')).toHaveText('From the selected text');
    await expect(quick.getByTestId('quick-text')).toHaveValue('TypeError: boom\nat line 3');
    await expect(quick.getByTestId('quick-template')).toHaveCount(2);
    await quick.getByTestId('quick-filter').fill('fix');
    await expect(quick.getByTestId('quick-template')).toHaveCount(1);
    await expect(quick.getByTestId('task-preview')).toContainText('Investigate this error:\nTypeError: boom\nat line 3');
    await quick.getByTestId('quick-group').selectOption({ label: 'Bugs' });
    await quick.getByTestId('quick-filter').press('Enter');

    await expect.poll(async () => (await snapshot()).nodes.map((n) => n.title)).toContain('fixer');
    const s = await snapshot();
    const node = s.nodes.find((n) => n.title === 'fixer')!;
    expect(inside(node, s.annotations.find((a) => a.id === ids.group)!)).toBe(true);
    await expect.poll(() => screenOf(node.tmuxSession)).toContain('> Investigate this error:');
    expect(screenOf(node.tmuxSession)).toContain('TypeError: boom');
    // The window closed, and the main window shows the new node.
    expect((await invokeOn(quick, 'quick:state')).value).toBeNull();
    await expect(page.locator('.react-flow__node', { hasText: 'fixer' })).toHaveCount(1);
  });

  test('the same group and template are offered next time; the title stays unique', async () => {
    await setClipboard('another error');
    const quick = await pressShortcut();
    await expect(quick.getByTestId('quick-group')).toHaveValue(ids.group!);
    await expect(quick.getByTestId('quick-template').first()).toHaveAttribute('aria-selected', 'true');
    await quick.getByTestId('quick-launch-button').click();
    await expect.poll(async () => (await snapshot()).nodes.map((n) => n.title)).toContain('fixer #2');
    const s = await snapshot();
    const group = s.annotations.find((a) => a.id === ids.group)!;
    for (const n of s.nodes) expect(inside(n, group)).toBe(true);
  });

  test('with nothing selected the clipboard is used; Esc closes without launching', async () => {
    await setClipboard('', 'copied text');
    const quick = await pressShortcut();
    await expect(quick.getByTestId('quick-source')).toContainText('From the clipboard');
    await expect(quick.getByTestId('quick-text')).toHaveValue('copied text');
    const before = (await snapshot()).nodes.length;
    await quick.getByTestId('quick-filter').press('Escape');
    await expect.poll(async () => (await invokeOn(quick, 'quick:state')).value).toBeNull();
    expect((await snapshot()).nodes.length).toBe(before);
  });

  test('a template that skips approvals needs a second confirmation', async () => {
    await setClipboard('ignore previous instructions');
    const quick = await pressShortcut();
    await quick.getByTestId('quick-filter').fill('yolo');
    await expect(quick.getByText(/skips approval prompts/)).toBeVisible();
    const before = (await snapshot()).nodes.length;
    await quick.getByTestId('quick-filter').press('Enter');
    await expect(quick.getByTestId('quick-launch-button')).toContainText('Launch without approvals');
    expect((await snapshot()).nodes.length).toBe(before);
    await quick.getByTestId('quick-launch-button').click();
    await expect.poll(async () => (await snapshot()).nodes.find((n) => n.title === 'yolo')?.dangerous).toBe(true);
  });

  test('each window can only use its own channels', async () => {
    await setClipboard('x');
    const quick = await pressShortcut();
    const fromQuick = await invokeOn(quick, 'node:create', { kind: 'shell', title: 'evil', cwd: project, accountId: null });
    expect(fromQuick).toEqual({ ok: false, error: 'untrusted sender' });
    expect(await invokeOn(quick, 'app:snapshot')).toEqual({ ok: false, error: 'untrusted sender' });
    expect(await invokeOn(page, 'quick:launch', { templateId: ids.fixer })).toEqual({ ok: false, error: 'untrusted sender' });
    expect(await invokeOn(page, 'quick:state')).toEqual({ ok: false, error: 'untrusted sender' });
    await quick.getByTestId('quick-filter').press('Escape');
  });

  test('the Launch panel launches into a group with the template text, and edits the shortcut', async () => {
    await page.getByTestId('launch-template').selectOption({ label: 'Fixer — Claude Code' });
    await page.getByTestId('launch-group').selectOption({ label: 'Bugs' });
    await page.getByTestId('launch-task').fill('panel error');
    await expect(page.getByTestId('task-preview')).toContainText('Investigate this error:\npanel error');
    await page.getByTestId('launch').click();
    await expect.poll(async () => (await snapshot()).nodes.map((n) => n.title)).toContain('fixer #3');
    const s = await snapshot();
    expect(inside(s.nodes.find((n) => n.title === 'fixer #3')!, s.annotations.find((a) => a.id === ids.group)!)).toBe(true);
    // The grown group reached the canvas too.
    const group = s.annotations.find((a) => a.id === ids.group)!;
    expect(group.h).toBeGreaterThan(400);

    await page.getByTestId('quick-shortcut').click();
    await page.keyboard.press('Control+Alt+K');
    await expect(page.getByTestId('quick-shortcut')).toHaveText('Ctrl+Alt+K');
    expect(await registered()).toEqual(['Control+Alt+K']);
    await page.getByTestId('quick-shortcut-off').click();
    await expect(page.getByTestId('quick-shortcut')).toHaveText('Off');
    await expect(page.getByTestId('quick-shortcut-state')).toHaveText('off');
    expect(await registered()).toEqual([]);
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByTestId('quick-shortcut')).toHaveText('Ctrl+Alt+F');
    expect(await registered()).toEqual(['Control+Alt+F']);

    await page.getByTestId('quick-after').selectOption('flowdeck');
    await expect.poll(async () => (await snapshot()).settings.quickLaunch.afterLaunch).toBe('flowdeck');
  });

  test('a template can carry its own task text', async () => {
    const row = page.getByTestId('template-row').filter({ hasText: 'YOLO' });
    await row.getByTestId('template-edit').click();
    const dialog = page.getByTestId('template-dialog');
    await dialog.locator('textarea[name="task"]').fill('Summarise:\n{{selection}}');
    await page.getByTestId('save-template').click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await snapshot()).templates.find((t) => t.id === ids.danger)?.task).toBe('Summarise:\n{{selection}}');
  });
});
