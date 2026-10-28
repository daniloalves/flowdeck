import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const APP_DIR = resolve(__dirname, '../..');
const root = mkdtempSync(join(tmpdir(), 'fdcv-'));
const home = join(root, 'home');
const tmuxSocket = `fdcv-${process.pid}`;
mkdirSync(home, { recursive: true });

type UntypedInvoke = (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; value?: unknown }>;
type Snap = {
  nodes: { id: string; title: string; tmuxSession: string; x: number; y: number }[];
  annotations: { id: string; kind: string; text: string; x: number; y: number; w: number; h: number }[];
};
let app: ElectronApplication;
let page: Page;
let node: { id: string; tmuxSession: string };

const tmux = (...args: string[]) => execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' });

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await page.evaluate(([c, a]) => (window.flowdeck.invoke as unknown as UntypedInvoke)(c, ...a), [channel, args] as const);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}

/** The in-memory clipboard of the app (FLOWDECK_TEST_CLIPBOARD): the user's is never touched. */
const clipboard = () =>
  app.evaluate(() => ({ ...(globalThis as unknown as { __flowdeckClipboard: { selection: string; clipboard: string } }).__flowdeckClipboard }));
const setClipboard = (selection: string, text: string) =>
  app.evaluate(
    (_e, [s, c]) => {
      Object.assign((globalThis as unknown as { __flowdeckClipboard: object }).__flowdeckClipboard, { selection: s, clipboard: c });
    },
    [selection, text] as const,
  );

/** Links the app asked to open (FLOWDECK_TEST_LINKS): no browser is started. */
const openedLinks = () => app.evaluate(() => [...(globalThis as unknown as { __flowdeckLinks: string[] }).__flowdeckLinks]);

const snapshot = () => invoke<Snap>('app:snapshot');
const lastLine = () =>
  tmux('capture-pane', '-p', '-t', node.tmuxSession)
    .split('\n')
    .filter((l) => l.trim())
    .pop() ?? '';

async function reloadAt(zoom: number): Promise<void> {
  await invoke('viewport:save', { x: 20, y: 20, zoom });
  await page.reload();
  await page.waitForSelector('.xterm-rows');
  await page.waitForTimeout(1200); // attach + first redraw
}

/** Drags across the row showing `text`, holding the pointer in the upper quarter of the row. */
async function dragOverRow(text: string): Promise<void> {
  const row = page.locator('.xterm-rows > div', { hasText: new RegExp(`^${text}\\s*$`) }).first();
  const box = (await row.boundingBox())!;
  const y = box.y + box.height * 0.25;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 6 });
  await page.mouse.up();
}

/** Centre of each terminal cell of `text` on the row showing it (cells measured from the pane width). */
async function cellsOf(text: string): Promise<{ x: (i: number) => number; y: number }> {
  const row = page.locator('.xterm-rows > div', { hasText: text }).first();
  const box = (await row.boundingBox())!;
  const cols = Number(tmux('display-message', '-p', '-t', node.tmuxSession, '#{pane_width}').trim());
  const line = ((await row.textContent()) ?? '').replace(/\u00a0/g, ' ');
  const start = line.indexOf(text);
  const cell = box.width / cols;
  return { x: (i) => box.x + (start + i + 0.5) * cell, y: box.y + box.height / 2 };
}

/** Prints `line` alone on a cleared screen. */
async function show(line: string): Promise<void> {
  tmux('send-keys', '-t', node.tmuxSession, `clear; ${line}`, 'Enter');
  await page.waitForTimeout(600);
}

/** Ctrl+click (or a plain click) on the `index`-th character of `text`. */
async function clickOn(text: string, index: number, ctrl: boolean): Promise<void> {
  const c = await cellsOf(text);
  await page.mouse.move(c.x(index), c.y, { steps: 3 }); // the link appears on hover
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.move(c.x(index) + 1, c.y);
  await page.mouse.click(c.x(index) + 1, c.y);
  if (ctrl) await page.keyboard.up('Control');
}

test.describe.serial('Terminal mouse and clipboard, renaming, canvas groups and texts', () => {
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
        FLOWDECK_SKIP_SHELL_ENV: '1',
        FLOWDECK_HIDE_WINDOW: '1',
        FLOWDECK_DISABLE_NOTIFICATIONS: '1',
        FLOWDECK_TEST_SHORTCUTS: '1', // never grab real keys on the desktop
        FLOWDECK_TEST_CLIPBOARD: '1',
        FLOWDECK_TEST_LINKS: '1',
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.fd-toolbar');
    node = await invoke('node:create', { kind: 'shell', title: 'probe', cwd: home, accountId: null, layout: { x: 0, y: 0, w: 700, h: 480 } });
    await reloadAt(1);
    tmux('send-keys', '-t', node.tmuxSession, "export PS1='$ '; clear; for i in $(seq 1 15); do echo LINE$i; done", 'Enter');
    await page.waitForTimeout(800);
  });

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

  for (const zoom of [1, 0.8, 1.5]) {
    test(`at ${zoom * 100}% zoom the pointer selects its own line, and selecting copies it`, async () => {
      await reloadAt(zoom);
      await setClipboard('', '');
      await dragOverRow('LINE8');
      await expect.poll(() => clipboard().then((c) => c.selection)).toBe('LINE8');
      expect((await clipboard()).clipboard).toBe('LINE8');
      expect(tmux('show-buffer')).toMatch(/^LINE8\n?$/); // vi selection: past the end includes the line break
    });
  }

  for (const zoom of [1, 0.8]) {
    test(`at ${zoom * 100}% zoom a drag copies every character from the first to the last one under the pointer`, async () => {
      await reloadAt(zoom);
      await setClipboard('', '');
      await show("echo 'xx abcdefghij yy'");
      const c = await cellsOf('abcdefghij');
      await page.mouse.move(c.x(0), c.y);
      await page.mouse.down();
      await page.mouse.move(c.x(9), c.y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => clipboard().then((x) => x.selection)).toBe('abcdefghij');
      // and from right to left
      await setClipboard('', '');
      await page.mouse.move(c.x(9), c.y);
      await page.mouse.down();
      await page.mouse.move(c.x(0), c.y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => clipboard().then((x) => x.selection)).toBe('abcdefghij');
    });
  }

  test('Ctrl+click opens a web link in the browser; a plain click does not', async () => {
    await reloadAt(1);
    await show("echo 'docs: https://example.com/a?b=1 done'");
    await clickOn('https://example.com', 10, false);
    await page.waitForTimeout(300);
    expect(await openedLinks()).toEqual([]);
    await clickOn('https://example.com', 10, true);
    await expect.poll(openedLinks).toEqual(['https://example.com/a?b=1']);
  });

  test('OSC 8 hyperlinks open their target; links that are not web links never open', async () => {
    await page.waitForTimeout(600); // opening is throttled
    await show(
      "printf '\\033]8;;https://example.org/osc8\\033\\\\Click here\\033]8;;\\033\\\\ or \\033]8;;file:///etc/passwd\\033\\\\Local file\\033]8;;\\033\\\\\\n'",
    );
    await clickOn('Click here', 2, true);
    await expect.poll(openedLinks).toEqual(['https://example.com/a?b=1', 'https://example.org/osc8']);
    await page.waitForTimeout(600);
    await clickOn('Local file', 2, true);
    await page.waitForTimeout(400);
    expect(await openedLinks()).toHaveLength(2);
  });

  test('a long URL wrapped over two lines opens whole', async () => {
    await page.waitForTimeout(600);
    const cols = Number(tmux('display-message', '-p', '-t', node.tmuxSession, '#{pane_width}').trim());
    const url = `https://example.net/${'p'.repeat(cols)}/end`;
    await show(`echo '${url}'`);
    await clickOn('/end', 1, true);
    await expect.poll(async () => (await openedLinks()).at(-1)).toBe(url);
  });

  test('a program inside a node cannot set the clipboard with OSC 52', async () => {
    await reloadAt(1);
    await setClipboard('kept', 'kept');
    // base64("EVIL") = RVZJTA==
    tmux('send-keys', '-t', node.tmuxSession, "printf '\\033]52;c;RVZJTA==\\a'; clear", 'Enter');
    await page.waitForTimeout(800);
    expect(await clipboard()).toEqual({ selection: 'kept', clipboard: 'kept' });
  });

  test('middle click pastes the selection; Ctrl+Shift+V pastes the clipboard', async () => {
    await setClipboard('echo FROM_PRIMARY', 'echo FROM_CLIPBOARD');
    const term = page.getByTestId(`terminal-${node.id}`);
    await term.click({ button: 'middle', position: { x: 200, y: 200 } });
    await expect.poll(lastLine).toContain('echo FROM_PRIMARY');
    expect(lastLine()).not.toContain('FROM_PRIMARY\r'); // pasted, not executed
    tmux('send-keys', '-t', node.tmuxSession, 'C-u');
    await page.keyboard.press('Control+Shift+V');
    await expect.poll(lastLine).toContain('echo FROM_CLIPBOARD');
    tmux('send-keys', '-t', node.tmuxSession, 'C-u');
  });

  test('scrolling back shows a slim scrollbar instead of the yellow tmux indicator; typing returns to the prompt', async () => {
    const mode = () => tmux('display', '-p', '-t', node.tmuxSession, '#{pane_in_mode} #{scroll_position} #{history_size}').trim();
    tmux('send-keys', '-t', node.tmuxSession, 'clear; seq 1 300', 'Enter');
    await page.waitForTimeout(600);
    const term = page.getByTestId(`terminal-${node.id}`);
    await term.click({ position: { x: 200, y: 150 } });
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -120); // the first turn enters scrollback, the next ones scroll
      await page.waitForTimeout(50);
    }
    const bar = page.getByTestId('terminal-scrollbar');
    await expect(bar).toHaveClass(/visible/);
    expect(mode()).toMatch(/^1 [1-9]/);
    await page.waitForTimeout(300);
    await expect(page.locator('.xterm-rows')).not.toContainText(/\[\d+\/\d+\]/); // tmux's position indicator

    // Dragging the thumb to the top shows the oldest line.
    const tb = (await bar.locator('.fd-scrollbar-thumb').boundingBox())!;
    const bb = (await bar.boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, bb.y - 40, { steps: 3 });
    await page.mouse.up();
    await expect.poll(() => mode().split(' ').slice(1).every((v, _i, a) => v === a[0])).toBe(true);

    // Typing leaves the scrollback and reaches the shell, without scrolling down first.
    await page.keyboard.type('echo TYPED');
    await expect.poll(mode).toMatch(/^0/);
    await expect.poll(lastLine).toContain('echo TYPED');
    await expect(bar).not.toHaveClass(/visible/);
    tmux('send-keys', '-t', node.tmuxSession, 'C-u');
  });

  test('a terminal is renamed from its header and from the Terminals panel', async () => {
    await page.getByTestId(`node-${node.id}`).getByTestId('node-rename').click();
    await page.getByTestId('node-title-input').fill('Backend API');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot()).nodes[0]!.title).toBe('Backend API');

    await page.getByTestId('toggle-terminals').click();
    const panel = page.getByTestId('terminals-panel');
    await panel.getByTestId('row-rename').click();
    await panel.getByTestId('row-title-input').fill('Frontend');
    await page.keyboard.press('Escape'); // cancels
    expect((await snapshot()).nodes[0]!.title).toBe('Backend API');
    await panel.getByTestId('row-rename').click();
    await panel.getByTestId('row-title-input').fill('Frontend');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot()).nodes[0]!.title).toBe('Frontend');
    await expect(page.getByTestId(`node-${node.id}`).locator('.fd-title')).toHaveText('Frontend');
    await page.getByTestId('toggle-terminals').click();
  });

  test('Ctrl+Shift+G groups the selected terminal; dragging the group moves it', async () => {
    await page.getByTestId(`node-${node.id}`).locator('.fd-node-header .fd-state-label').click();
    await page.keyboard.press('Control+Shift+G');
    await page.getByTestId('group-title-input').fill('Team A');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot()).annotations.map((a) => a.text)).toEqual(['Team A']);
    const before = await snapshot();
    const group = before.annotations[0]!;
    const term = before.nodes[0]!;
    expect(group.x).toBeLessThan(term.x);
    expect(group.y + 36).toBeLessThan(term.y);

    await invoke('viewport:save', { x: 200, y: 200, zoom: 0.9 }); // the group's title bar is above the view
    await page.reload();
    await page.waitForSelector('.fd-group-header');
    const header = page.getByTestId(`group-${group.id}`).locator('.fd-group-header');
    const box = (await header.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    // React Flow starts the drag after a few pixels, so the group moves a bit less than the mouse.
    await expect.poll(async () => (await snapshot()).annotations[0]!.x - group.x).toBeGreaterThan(50);
    const after = await snapshot();
    expect(after.annotations[0]!.y - group.y).toBeGreaterThan(20);
    // The terminal moved by exactly the same amount as the group.
    expect(after.nodes[0]!.x - term.x).toBeCloseTo(after.annotations[0]!.x - group.x, 3);
    expect(after.nodes[0]!.y - term.y).toBeCloseTo(after.annotations[0]!.y - group.y, 3);
  });

  test('a group drawn by dragging, and a text added with the Text tool, survive a reload', async () => {
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } }); // clear the selection
    await page.getByTestId('draw-group').click();
    const layer = page.getByTestId('draw-layer');
    await expect(layer).toBeVisible();
    const lb = (await layer.boundingBox())!;
    await page.mouse.move(lb.x + lb.width - 300, lb.y + 100);
    await page.mouse.down();
    await page.mouse.move(lb.x + lb.width - 60, lb.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.getByTestId('group-title-input').fill('Drawn');
    await page.keyboard.press('Enter');
    await expect(layer).toBeHidden();

    await page.keyboard.press('Control+Shift+X');
    await page.mouse.click(lb.x + lb.width - 280, lb.y + 400);
    await page.getByTestId('text-input').fill('Line one\nLine two');
    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => (await snapshot()).annotations.map((a) => `${a.kind}:${a.text}`).sort()).toEqual([
      'group:Drawn',
      'group:Team A',
      'text:Line one\nLine two',
    ]);
    const drawn = (await snapshot()).annotations.find((a) => a.text === 'Drawn')!;
    expect(drawn.w).toBeGreaterThan(150);
    expect(drawn.h).toBeGreaterThan(100);

    await page.reload();
    await page.waitForSelector('.fd-toolbar');
    await expect(page.locator('.fd-group-header', { hasText: 'Team A' })).toBeVisible();
    await expect(page.locator('.fd-text', { hasText: 'Line two' })).toBeVisible();
  });

  test('Delete removes a selected text but never a terminal; deleting a group keeps its terminals', async () => {
    await page.locator('.fd-text', { hasText: 'Line two' }).click();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await snapshot()).annotations.some((a) => a.kind === 'text')).toBe(false);

    await page.getByTestId(`node-${node.id}`).locator('.fd-node-header .fd-state-label').click();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    expect((await snapshot()).nodes).toHaveLength(1);

    const team = (await snapshot()).annotations.find((a) => a.text === 'Team A')!;
    await page.getByTestId(`group-${team.id}`).locator('.fd-group-header').click();
    await page.getByTestId('annotation-toolbar').getByTestId('annotation-delete').click();
    await expect.poll(async () => (await snapshot()).annotations.map((a) => a.text)).toEqual(['Drawn']);
    expect((await snapshot()).nodes).toHaveLength(1);
  });

  test('a text over a terminal stays in front of it, also while the terminal is selected or focused', async () => {
    const term = (await snapshot()).nodes[0]!;
    const text = await invoke<{ id: string }>('annotation:create', {
      kind: 'text',
      text: 'On top',
      color: '#e6e6ef',
      x: term.x + 40,
      y: term.y + 80,
      w: 200,
      h: 40,
    });
    await page.reload();
    await page.waitForSelector('.xterm-rows');
    const box = page.getByTestId(`text-${text.id}`);
    /** Whether the text is the topmost element at its own centre. */
    const inFront = async () => {
      const b = (await box.boundingBox())!;
      return page.evaluate(
        ([id, x, y]) => document.elementFromPoint(x, y)?.closest(`[data-testid="text-${id}"]`) != null,
        [text.id, b.x + b.width / 2, b.y + b.height / 2] as const,
      );
    };
    await expect.poll(inFront).toBe(true);

    const terminal = page.getByTestId(`node-${node.id}`);
    await terminal.locator('.fd-node-header .fd-state-label').click(); // selects the terminal
    await expect(terminal.locator('xpath=ancestor::div[contains(@class,"react-flow__node")][1]')).toHaveClass(/selected/);
    expect(await inFront()).toBe(true);
    await terminal.locator('.xterm-screen').click({ position: { x: 10, y: 10 } }); // focuses it
    expect(await inFront()).toBe(true);

    // Clicking the text selects it (not the terminal) and it can still be edited.
    await page.locator('.fd-text', { hasText: 'On top' }).dblclick();
    await page.getByTestId('text-input').fill('Still on top');
    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => (await snapshot()).annotations.find((a) => a.id === text.id)?.text).toBe('Still on top');
    expect(await inFront()).toBe(true);
  });
});
