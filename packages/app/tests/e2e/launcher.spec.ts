import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const APP_DIR = resolve(__dirname, '../..');
const fixture = (name: string) => join(APP_DIR, 'tests/fixtures', name);
const root = mkdtempSync(join(tmpdir(), 'fdln-'));
const home = join(root, 'home');
const project = join(home, 'project');
const tmuxSocket = `fdln-${process.pid}`;
for (const d of ['.claude', 'project']) mkdirSync(join(home, d), { recursive: true });

type UntypedInvoke = (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; value?: unknown }>;
type Snap = {
  nodes: { id: string; title: string; tmuxSession: string; w: number; h: number; launchArgs: string[] }[];
  templates: { id: string; name: string; kind: string; title: string; cwd: string; launchArgs: string[]; w: number; h: number }[];
};
let app: ElectronApplication;
let page: Page;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await page.evaluate(([c, a]) => (window.flowdeck.invoke as unknown as UntypedInvoke)(c, ...a), [channel, args] as const);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}

const snapshot = () => invoke<Snap>('app:snapshot');
const screenOf = (session: string) => execFileSync('tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-t', session], { encoding: 'utf8' });

test.describe.serial('Node templates and the task launcher', () => {
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
        FLOWDECK_TEST_SHORTCUTS: '1', // never grab real keys on the desktop
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.fd-toolbar');
    await invoke('account:upsert', { id: 'default', label: 'Claude main', configDir: join(home, '.claude'), color: '#7c6cf2' });
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

  test('"Save as template" turns the New node settings into a template', async () => {
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('Control+Shift+N');
    const dialog = page.getByTestId('new-node-dialog');
    await page.getByTestId('kind-claude').click();
    await dialog.locator('input[name="title"]').fill('reviewer');
    await dialog.locator('input[name="cwd"]').fill(project);
    await dialog.locator('input[name="args"]').fill('--model opus');
    await page.getByTestId('save-as-template').click();
    await expect(dialog).toBeHidden();

    const editor = page.getByTestId('template-dialog');
    await expect(editor.locator('input[name="name"]')).toHaveValue('reviewer');
    await expect(editor.locator('input[name="cwd"]')).toHaveValue(project);
    await editor.locator('input[name="name"]').fill('Review');
    await editor.locator('input[name="w"]').fill('800');
    await page.getByTestId('save-template').click();
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await snapshot()).templates).toEqual([
      expect.objectContaining({ name: 'Review', kind: 'claude', title: 'reviewer', cwd: project, launchArgs: ['--model', 'opus'], w: 800, h: 440 }),
    ]);
    expect((await snapshot()).nodes).toHaveLength(0);
  });

  test('Ctrl+Shift+L opens the Launch panel; a launched node starts working on its task', async () => {
    await page.keyboard.press('Control+Shift+L');
    const panel = page.getByTestId('launch-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('launch-title')).toHaveAttribute('placeholder', 'reviewer');
    const task = page.getByTestId('launch-task');
    await expect(task).toBeFocused();
    await task.fill('check the login flow\nlist the risks');
    await expect(page.getByTestId('launch-bytes')).toHaveText('0.0 / 12 KB');
    await task.press('Control+Enter');

    await expect.poll(async () => (await snapshot()).nodes.map((n) => n.title)).toEqual(['reviewer']);
    const node = (await snapshot()).nodes[0]!;
    expect(node).toMatchObject({ w: 800, h: 440, launchArgs: ['--model', 'opus'] });
    await expect.poll(() => screenOf(node.tmuxSession)).toContain('> check the login flow');
    await expect(task).toHaveValue('');

    // A second launch without a task gets its own title (peers are addressed by title).
    await page.getByTestId('launch').click();
    await expect.poll(async () => (await snapshot()).nodes.map((n) => n.title).sort()).toEqual(['reviewer', 'reviewer #2']);
  });

  test('tasks over 12 KB cannot be launched; a refused task creates no node', async () => {
    const task = page.getByTestId('launch-task');
    await task.fill('x '.repeat(6 * 1024 + 1));
    await expect(page.getByTestId('launch-bytes')).toHaveClass(/fd-warn/);
    await expect(page.getByTestId('launch')).toBeDisabled();

    await task.fill('mcp');
    await page.getByTestId('launch').click();
    await expect(page.locator('.fd-toast-error', { hasText: 'subcommand' })).toBeVisible();
    expect((await snapshot()).nodes).toHaveLength(2);
  });

  test('templates are edited and deleted from the panel; launched nodes stay', async () => {
    const row = page.getByTestId('template-row').filter({ hasText: 'Review' });
    await row.getByTestId('template-edit').click();
    const editor = page.getByTestId('template-dialog');
    await expect(editor.locator('input[name="args"]')).toHaveValue('--model opus');
    await editor.locator('input[name="name"]').fill('Code review');
    await page.getByTestId('save-template').click();
    await expect.poll(async () => (await snapshot()).templates.map((t) => t.name)).toEqual(['Code review']);
    await expect(page.getByTestId('template-row')).toHaveText(/Code review/);

    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('template-row').getByTestId('template-delete').click();
    await expect.poll(async () => (await snapshot()).templates).toEqual([]);
    await expect(page.getByTestId('launch-panel')).toContainText('Create a template first');
    expect((await snapshot()).nodes).toHaveLength(2);
  });
});
