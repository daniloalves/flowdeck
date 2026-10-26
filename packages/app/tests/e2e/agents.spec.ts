import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const APP_DIR = resolve(__dirname, '../..');
const fixture = (name: string) => join(APP_DIR, 'tests/fixtures', name);
const root = mkdtempSync(join(tmpdir(), 'fdag-'));
const home = join(root, 'home');
const tmuxSocket = `fdag-${process.pid}`;
for (const d of ['.claude', '.codex', 'project']) mkdirSync(join(home, d), { recursive: true });

type UntypedInvoke = (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; value?: unknown }>;
let app: ElectronApplication;
let page: Page;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await page.evaluate(([c, a]) => (window.flowdeck.invoke as unknown as UntypedInvoke)(c, ...a), [channel, args] as const);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}

const nodeCount = () => page.locator('[data-testid^="node-"][data-state]').count();

/** Brings a node into view through the Terminals panel ("Go to"), then focuses its terminal. */
async function focusTerminal(title: string): Promise<void> {
  const panel = page.getByTestId('terminals-panel');
  if (!(await panel.isVisible())) await page.getByTestId('toggle-terminals').click();
  await panel.getByTestId('terminal-row').filter({ hasText: title }).first().locator('.fd-term-main').click();
  const node = (await invoke<{ nodes: { id: string; title: string }[] }>('app:snapshot')).nodes.find((n) => n.title === title)!;
  await page.waitForTimeout(400); // centering animation
  await page.getByTestId(`terminal-${node.id}`).click();
}

test.describe.serial('Codex, Kiro, Terminals panel and shortcuts', () => {
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
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.fd-toolbar');
    await invoke('account:upsert', { id: 'codex', agent: 'codex', label: 'Codex main', configDir: join(home, '.codex'), color: '#3cb4f2' });
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

  test('Ctrl+Shift+N opens the dialog; Codex and several Kiro nodes are created from it', async () => {
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('Control+Shift+N');
    const dialog = page.getByTestId('new-node-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('kind-codex').click();
    await expect(dialog).toContainText('Trust all and continue');
    await dialog.locator('input[name="title"]').fill('coder');
    await dialog.locator('input[name="cwd"]').fill(join(home, 'project'));
    await expect(dialog.locator('select[name="account"]')).toHaveValue('codex');
    await page.getByTestId('create-node').click();
    await expect(dialog).toBeHidden();
    await expect.poll(nodeCount).toBe(1);

    // the dialog remembers the directory; "How many" creates a grid of nodes
    await page.keyboard.press('Control+Shift+N');
    await page.getByTestId('kind-kiro').click();
    await expect(dialog.locator('input[name="cwd"]')).toHaveValue(join(home, 'project'));
    await expect(dialog.locator('select[name="account"]')).toHaveCount(0);
    await dialog.locator('input[name="title"]').fill('kiro');
    await dialog.locator('input[name="count"]').fill('2');
    await page.getByTestId('create-node').click();
    await expect.poll(nodeCount).toBe(3);
    const titles = (await invoke<{ nodes: { title: string; kind: string }[] }>('app:snapshot')).nodes.map((n) => `${n.kind}:${n.title}`);
    expect(titles.sort()).toEqual(['codex:coder', 'kiro:kiro #1', 'kiro:kiro #2']);
  });

  test('the Terminals panel lists every node with its live state, counts and a legend', async () => {
    await page.getByTestId('toggle-terminals').click();
    const panel = page.getByTestId('terminals-panel');
    await expect(panel.getByTestId('terminal-row')).toHaveCount(3);
    const legend = panel.getByTestId('legend');
    for (const label of ['Needs you', 'Working', 'Starting', 'Unknown', 'Idle', 'Stopped', 'Red ring']) {
      await expect(legend).toContainText(label);
    }

    // a Codex approval request turns its bullet orange, moves it to the top and shows on the tab
    await focusTerminal('coder');
    await page.keyboard.type('PERMISSION run tests');
    await page.keyboard.press('Enter');
    await expect(panel.getByTestId('terminal-row').first()).toHaveAttribute('data-state', 'needs_input');
    await expect(panel.getByTestId('terminal-row').first()).toContainText('Approval needed: run the test suite');
    await expect(panel.getByTestId('state-counts')).toContainText('1 needs you');
    await expect(page.getByTestId('toggle-terminals')).toContainText('1');

    await page.keyboard.type('y');
    await page.keyboard.press('Enter');
    await expect(panel.locator('[data-testid="terminal-row"][data-state="needs_input"]')).toHaveCount(0);
  });

  test('Ctrl+Shift+N inside a terminal opens the dialog instead of typing', async () => {
    await focusTerminal('coder');
    await page.keyboard.press('Control+Shift+N');
    await expect(page.getByTestId('new-node-dialog')).toBeVisible();
    // focus moved to the dialog: typing goes there, not to the agent
    await expect(page.locator('[data-testid="new-node-dialog"] input[name="title"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('new-node-dialog')).toBeHidden();
  });

  test('duplicate from the panel and with Ctrl+Shift+D on the selected node', async () => {
    const panel = page.getByTestId('terminals-panel');
    const coderRow = panel.getByTestId('terminal-row').filter({ hasText: 'coder' });
    await coderRow.getByTestId('row-duplicate').click();
    await expect.poll(nodeCount).toBe(4);

    const snapshot = await invoke<{ nodes: { id: string; title: string; kind: string; accountId: string | null }[] }>('app:snapshot');
    expect(snapshot.nodes.find((n) => n.title === 'coder #2')).toMatchObject({ kind: 'codex', accountId: 'codex' });

    // "Go to" from the panel selects that node only; the shortcut then duplicates it
    await panel.getByTestId('terminal-row').filter({ hasText: 'kiro #1' }).locator('.fd-term-main').click();
    const kiro = snapshot.nodes.find((n) => n.title === 'kiro #1')!;
    await expect(page.locator(`.react-flow__node[data-id="${kiro.id}"]`)).toHaveClass(/selected/);
    await page.keyboard.press('Control+Shift+D');
    await expect.poll(nodeCount).toBe(5);
    const titles = (await invoke<{ nodes: { title: string }[] }>('app:snapshot')).nodes.map((n) => n.title);
    expect(titles).toContain('kiro #3');
  });
});
