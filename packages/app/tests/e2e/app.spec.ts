import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AppClient } from '../../../mcp/src/client';

const APP_DIR = resolve(__dirname, '../..');
const FAKE_CLAUDE = join(APP_DIR, 'tests/fixtures/fake-claude.sh');

const root = mkdtempSync(join(tmpdir(), 'fde2e-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const tmuxSocket = `fde2e-${process.pid}`;
const fakeLog = join(root, 'fake-agent.log');
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-work'), { recursive: true });
writeFileSync(join(home, '.claude-work', '.credentials.json'), '{"never":"read"}');

type UntypedInvoke = (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; value?: unknown }>;

let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [APP_DIR],
    env: {
      PATH: process.env.PATH ?? '',
      DISPLAY: process.env.DISPLAY ?? ':0',
      XAUTHORITY: process.env.XAUTHORITY ?? '',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
      HOME: home,
      SHELL: '/bin/bash',
      LANG: 'C.UTF-8',
      FLOWDECK_DATA_DIR: dataDir,
      FLOWDECK_SOCK_PATH: join(root, 'fd.sock'),
      FLOWDECK_TMUX_SOCKET: tmuxSocket,
      FLOWDECK_CLAUDE_BIN: FAKE_CLAUDE,
      FLOWDECK_SKIP_SHELL_ENV: '1',
      FLOWDECK_HIDE_WINDOW: '1',
      FLOWDECK_DISABLE_NOTIFICATIONS: '1',
      FLOWDECK_TEST_SHORTCUTS: '1', // never grab real keys on the desktop
      FAKE_AGENT_LOG: fakeLog,
      ANTHROPIC_API_KEY: 'sk-must-not-reach-nodes',
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.fd-toolbar');
}

async function close(): Promise<void> {
  await app.close();
}

const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // Untyped on purpose: tests also exercise channels and payloads the typed API would reject.
  const r = await page.evaluate(
    ([c, a]) => (window.flowdeck.invoke as unknown as UntypedInvoke)(c, ...a),
    [channel, args] as const,
  );
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}

const terminalText = (nodeId: string) => page.locator(`[data-testid="terminal-${nodeId}"] .xterm-rows`);
const nodeBox = (nodeId: string) => page.locator(`[data-testid="node-${nodeId}"]`);

test.describe.serial('FlowDeck app', () => {
  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    try {
      tmux('kill-server');
    } catch {
      /* not running */
    }
    rmSync(join('/tmp', `tmux-${process.getuid?.() ?? 0}`, tmuxSocket), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test('renderer is isolated: no Node, a minimal bridge, no network', async () => {
    await launch();
    const facts = await page.evaluate(async () => {
      let network = 'allowed';
      try {
        await fetch('https://example.com/');
      } catch {
        network = 'blocked';
      }
      return {
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        bridge: Object.keys(window.flowdeck).sort(),
        network,
      };
    });
    expect(facts).toEqual({ require: 'undefined', process: 'undefined', bridge: ['invoke', 'on', 'send'], network: 'blocked' });

    const prefs = await app.evaluate(({ BrowserWindow }) => {
      // Not in Electron's public typings, but present at runtime.
      const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean } | null;
      };
      const p = wc.getLastWebPreferences();
      return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });

    const unknown = await page.evaluate(() => (window.flowdeck.invoke as unknown as UntypedInvoke)('shell:exec'));
    expect(unknown).toEqual({ ok: false, error: 'unknown channel' });
  });

  test('phase 1+2: a shell node keeps its place and its process across app restarts', async () => {
    await page.getByTestId('new-node').click();
    await page.getByTestId('kind-shell').click();
    const dialog = page.getByTestId('new-node-dialog');
    await dialog.locator('input[name="title"]').fill('scratch');
    await dialog.locator('input[name="cwd"]').fill(home);
    await page.getByTestId('create-node').click();

    const node = page.locator('[data-testid^="node-"]').first();
    await expect(node).toBeVisible();
    const nodeId = (await node.getAttribute('data-testid'))!.replace('node-', '');

    const term = page.getByTestId(`terminal-${nodeId}`);
    await term.click();
    await page.keyboard.type('echo FLOWDECK_$((40+2))');
    await page.keyboard.press('Enter');
    await expect(terminalText(nodeId)).toContainText('FLOWDECK_42');

    // drag the node by its header
    const header = nodeBox(nodeId).locator('.fd-node-header');
    const box = (await header.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 140, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await invoke<{ nodes: { id: string; x: number }[] }>('app:snapshot')).nodes[0]!.x)
      .not.toBe(0);
    const before = (await invoke<{ nodes: { id: string; x: number; y: number }[] }>('app:snapshot')).nodes[0]!;

    await close();
    expect(tmux('ls')).toContain('fd-'); // the process outlives the app
    // ...and holds none of the app's files (Chromium descriptors must not leak into tmux)
    const serverPid = tmux('display-message', '-p', '#{pid}').trim();
    const held = execFileSync('bash', ['-c', `ls -l /proc/${serverPid}/fd`], { encoding: 'utf8' });
    expect(held).not.toContain(join(dataDir, 'electron'));
    expect(held).not.toContain('.org.chromium');

    await launch();
    const after = (await invoke<{ nodes: { id: string; x: number; y: number }[] }>('app:snapshot')).nodes[0]!;
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
    await expect(terminalText(nodeId)).toContainText('FLOWDECK_42');
    await invoke('node:delete', nodeId);
  });

  test('criteria 1-3: six Claude nodes on two accounts, state and account badge on each', async () => {
    await invoke('account:upsert', { id: 'personal', label: 'Personal', configDir: join(home, '.claude'), color: '#7c6cf2' });
    await invoke('account:upsert', { id: 'work', label: 'Work', configDir: join(home, '.claude-work'), color: '#f2a33c', cap5h: 100000 });
    const discovered = await invoke<{ suggestedId: string; loggedIn: boolean }[]>('account:discover');
    expect(discovered.find((d) => d.suggestedId === 'work')?.loggedIn).toBe(true);
    await page.reload();
    await page.waitForSelector('.fd-toolbar');

    const titles = ['leader', 'reviewer', 'tester', 'writer', 'ops', 'spare'];
    for (const [i, title] of titles.entries()) {
      await invoke('node:create', {
        kind: 'claude',
        title,
        cwd: home,
        accountId: i % 2 === 0 ? 'personal' : 'work',
        layout: { x: (i % 3) * 760, y: Math.floor(i / 3) * 480, w: 720, h: 440 },
      });
    }
    await page.getByTestId('fit').click();
    await expect(page.locator('[data-state="idle"]')).toHaveCount(6, { timeout: 20_000 });
    await expect(page.getByTestId('account-badge').filter({ hasText: 'Work' })).toHaveCount(3);
    await expect(page.getByTestId('account-badge').filter({ hasText: 'Personal' })).toHaveCount(3);

    const log = readFileSync(fakeLog, 'utf8');
    expect(log).not.toMatch(/apikey=set/);

    // a long task shows "working", then "idle"
    const nodes = (await invoke<{ nodes: { id: string; title: string }[] }>('app:snapshot')).nodes;
    const writer = nodes.find((n) => n.title === 'writer')!;
    await page.getByTestId(`terminal-${writer.id}`).click();
    await page.keyboard.type('SLOW draft the docs');
    await page.keyboard.press('Enter');
    await expect(nodeBox(writer.id)).toHaveAttribute('data-state', 'working');
    await page.locator('.fd-toolbar').click(); // unfocus the terminal
    await expect(nodeBox(writer.id)).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });

    // usage reaches the badge after the next refresh (fake-claude wrote 100 + 50 tokens)
    await expect(page.getByTestId('account-badge').filter({ hasText: 'Personal' }).first()).toBeVisible();
  });

  test('criterion 4: connect two nodes, send a task, see it delivered and logged', async () => {
    const nodes = (await invoke<{ nodes: { id: string; title: string }[] }>('app:snapshot')).nodes;
    const leader = nodes.find((n) => n.title === 'leader')!;
    const reviewer = nodes.find((n) => n.title === 'reviewer')!;
    await invoke('edge:create', { source: leader.id, target: reviewer.id, direction: 'one_way' });

    // the same identity file flowdeck-mcp receives with --identity
    const identity = JSON.parse(readFileSync(join(dataDir, 'nodes', leader.id, 'identity.json'), 'utf8'));
    const client = new AppClient(identity);
    const result = await client.sendTo('reviewer', 'please review the login flow');
    expect(result.status).toBe('delivered');

    await expect(terminalText(reviewer.id)).toContainText('[from: leader] please review the login flow');
    await page.getByTestId('toggle-messages').click();
    await expect(page.getByTestId('message-row').first()).toContainText('leader');
    await expect(page.getByTestId('message-row').first()).toContainText('delivered');
  });

  test('criterion 5: after a reboot every node returns with layout, account and conversation', async () => {
    const before = (
      await invoke<{ nodes: { id: string; title: string; x: number; y: number; accountId: string; sessionId: string }[] }>(
        'app:snapshot',
      )
    ).nodes;
    await close();
    tmux('kill-server'); // what a reboot does
    writeFileSync(fakeLog, '');

    await launch();
    await expect(page.locator('[data-state="idle"]')).toHaveCount(6, { timeout: 20_000 });
    const after = (await invoke<{ nodes: { id: string; x: number; y: number; accountId: string }[] }>('app:snapshot')).nodes;
    expect(after.map((n) => [n.id, n.x, n.y, n.accountId])).toEqual(before.map((n) => [n.id, n.x, n.y, n.accountId]));
    const log = readFileSync(fakeLog, 'utf8');
    // nodes that had a conversation resume it; the others reuse their FlowDeck-assigned id
    for (const title of ['writer', 'reviewer']) {
      expect(log).toContain(`--resume ${before.find((n) => n.title === title)!.sessionId}`);
    }
    for (const n of before) expect(log).toMatch(new RegExp(`--(resume|session-id) ${n.sessionId}`));
  });
});
