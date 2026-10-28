import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NodeState } from '@flowdeck/shared';
import { createHarness, waitFor, type Harness } from '../helpers';

/** Templates and launching a node with its first task, with real tmux and the fake agents. */
describe('task launcher', () => {
  let h: Harness;
  let project: string;

  const state = (id: string): NodeState => h.repo.getStatus(id).state;
  const log = () => readFileSync(h.logFile, 'utf8');
  const argsLines = (personality: string) => log().split('\n').filter((l) => l.startsWith(`ARGS ${personality}`));
  const claudePrompts = (id: string) => {
    const file = join(h.home, '.claude', 'projects', '-fake-project', `${h.repo.getNode(id)!.sessionId}.jsonl.prompts`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const screen = (id: string) => h.tmux.capture(h.repo.getNode(id)!.tmuxSession, 200);
  const sessions = async () => (await h.tmux.listPanes())?.map((p) => p.session) ?? [];

  beforeAll(async () => {
    h = await createHarness();
    project = join(h.home, 'project');
    mkdirSync(project);
    h.core.upsertAccount({ id: 'default', label: 'Claude', configDir: join(h.home, '.claude'), color: '#7c6cf2' });
    h.core.upsertAccount({ id: 'codex', agent: 'codex', label: 'Codex', configDir: join(h.home, '.codex'), color: '#3cb4f2' });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('templates are checked like new nodes, updated in place and listed in the snapshot', () => {
    const base = { name: 'Reviewer', kind: 'claude', cwd: project, accountId: 'default', launchArgs: ['--model', 'opus'], w: 900, h: 500 };
    const t = h.core.saveTemplate(null, base);
    expect(t).toMatchObject({ name: 'Reviewer', title: '', accountId: 'default', w: 900 });
    expect(() => h.core.saveTemplate(null, { ...base, cwd: join(h.home, 'missing') })).toThrow(/directory not found/);
    expect(() => h.core.saveTemplate(null, { ...base, accountId: 'codex' })).toThrow(/not a Claude Code account/);
    expect(() => h.core.saveTemplate(null, { ...base, launchArgs: ['--resume', 'x'] })).toThrow(/managed by FlowDeck/);
    expect(() => h.core.saveTemplate(null, { ...base, kind: 'shell', accountId: null, launchArgs: ['-x'] })).toThrow(/shell nodes/);
    expect(() => h.core.saveTemplate('nope', base)).toThrow(/template not found/);
    const updated = h.core.saveTemplate(t.id, { ...base, title: 'review', w: 1000 });
    expect(updated).toMatchObject({ id: t.id, title: 'review', w: 1000, createdAt: t.createdAt });
    expect(h.core.snapshot().templates.map((x) => x.id)).toEqual([t.id]);
    h.core.deleteTemplate(t.id);
    expect(h.core.snapshot().templates).toEqual([]);
  });

  it('a Claude node starts with its task as the first prompt, and a restart does not send it again', async () => {
    const task = 'review the login flow\nand list the risks';
    const node = await h.core.createNode({ kind: 'claude', title: 'reviewer', cwd: project, accountId: 'default', task });
    expect(argsLines('claude').pop()).toContain(`-- $'review the login flow\\nand list the risks'`);
    await waitFor(() => claudePrompts(node.id).includes('and list the risks'));
    await waitFor(() => state(node.id) === 'idle');
    expect(await screen(node.id)).toContain('> review the login flow');

    await h.core.restartNode(node.id);
    await waitFor(() => state(node.id) === 'idle');
    expect(argsLines('claude').pop()).not.toContain('review the login flow');
    expect(claudePrompts(node.id).match(/review the login flow/g)).toHaveLength(1);
  });

  it('a 12 KiB task of multi-byte characters reaches the agent intact through tmux', async () => {
    const task = 'ação '.repeat(1755).trim(); // 12 284 bytes of UTF-8
    expect(Buffer.byteLength(task)).toBeGreaterThan(12 * 1024 - 8);
    expect(Buffer.byteLength(task)).toBeLessThanOrEqual(12 * 1024);
    const node = await h.core.createNode({ kind: 'claude', title: 'big', cwd: project, accountId: 'default', task });
    await waitFor(() => claudePrompts(node.id).includes(task));
  });

  it('Codex and Kiro take the task after --; a task starting with dashes stays a prompt', async () => {
    const codex = await h.core.createNode({ kind: 'codex', title: 'coder', cwd: project, accountId: 'codex', task: '--version is wrong, fix it' });
    expect(codex.status.detail).toMatch(/with your task/);
    await waitFor(async () => (await screen(codex.id)).includes('> --version is wrong, fix it'));
    expect(argsLines('codex').pop()).toMatch(/ -- --version\\ is\\ wrong\\,\\ fix\\ it$/);

    const kiro = await h.core.createNode({ kind: 'kiro', title: 'kiro', cwd: project, accountId: null, task: 'summarise the README' });
    await waitFor(async () => (await screen(kiro.id)).includes('> summarise the README'));
    expect(argsLines('kiro').pop()).toMatch(/chat -- summarise\\ the\\ README$/);
  });

  it('a shell node types its task once the shell starts', async () => {
    const node = await h.core.createNode({ kind: 'shell', title: 'sh', cwd: project, accountId: null, task: 'echo LAUNCHED-$((6 * 7))' });
    await waitFor(async () => (await screen(node.id)).includes('LAUNCHED-42'));
  });

  it('launching a template composes its task, picks a unique title and places the node', async () => {
    const t = h.core.saveTemplate(null, {
      name: 'Fixer',
      kind: 'claude',
      title: 'fixer',
      cwd: project,
      accountId: 'default',
      w: 500,
      h: 300,
      task: 'Investigate this error:\n{{selection}}',
    });
    const a = await h.core.launchTemplate({ templateId: t.id, text: 'TypeError: x is undefined', center: { x: 1000, y: 1000 } });
    expect(a).toMatchObject({ title: 'fixer', x: 750, y: 850, w: 500, h: 300 });
    await waitFor(() => claudePrompts(a.id).includes('Investigate this error:\nTypeError: x is undefined'));
    const b = await h.core.launchTemplate({ templateId: t.id, text: 'second', center: { x: 1000, y: 1000 } });
    expect(b).toMatchObject({ title: 'fixer #2', x: 790, y: 890 });
    const c = await h.core.launchTemplate({ templateId: t.id, title: 'mine', text: '' });
    expect(c.title).toBe('mine');
    await waitFor(() => claudePrompts(c.id).includes('Investigate this error:'));
    expect(h.events.filter((e) => e.channel === 'node:changed' && (e.payload as { id: string }).id === c.id).length).toBeGreaterThan(0);

    expect(h.core.describeTemplates().find((x) => x.id === t.id)).toMatchObject({ skipsApprovals: false, problem: null, task: t.task });
    await expect(h.core.launchTemplate({ templateId: 'missing' })).rejects.toThrow(/template not found/);
    await expect(h.core.launchTemplate({ templateId: t.id, text: 'x'.repeat(12 * 1024) })).rejects.toThrow(/longer than 12 KB/);
  });

  it('a template launched into a group lands inside it, and a full group grows', async () => {
    const t = h.core.saveTemplate(null, { name: 'Small', kind: 'shell', cwd: project, accountId: null, w: 300, h: 200 });
    const group = h.core.createAnnotation({ kind: 'group', text: 'Team', color: '#7c6cf2', x: 5000, y: 5000, w: 420, h: 320 });
    expect(h.core.groups()).toContainEqual({ id: group.id, title: 'Team', color: '#7c6cf2' });
    const inGroup = (n: { x: number; y: number; w: number; h: number }, g: typeof group) =>
      n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h;

    const first = await h.core.launchTemplate({ templateId: t.id, groupId: group.id });
    expect(inGroup(first, h.repo.getAnnotation(group.id)!)).toBe(true);
    expect(h.repo.getAnnotation(group.id)!.h).toBe(320);

    const second = await h.core.launchTemplate({ templateId: t.id, groupId: group.id });
    const grown = h.repo.getAnnotation(group.id)!;
    expect(grown.h).toBeGreaterThan(320);
    expect(inGroup(first, grown) && inGroup(second, grown)).toBe(true);
    expect(h.events.some((e) => e.channel === 'annotation:changed' && (e.payload as { id: string; h: number }).h === grown.h)).toBe(true);

    const text = h.core.createAnnotation({ kind: 'text', text: 'note', color: '#ffffff', x: 0, y: 0, w: 100, h: 40 });
    await expect(h.core.launchTemplate({ templateId: t.id, groupId: text.id })).rejects.toThrow(/group not found/);
  });

  it('settings default to Ctrl+Alt+F and staying in the source app; bad shortcuts are refused', () => {
    expect(h.core.snapshot().settings).toEqual({ quickLaunch: { shortcut: 'Control+Alt+F', afterLaunch: 'stay' } });
    expect(h.core.updateSettings({ quickLaunch: { afterLaunch: 'flowdeck' } })).toEqual({
      quickLaunch: { shortcut: 'Control+Alt+F', afterLaunch: 'flowdeck' },
    });
    expect(h.core.updateSettings({ quickLaunch: { shortcut: '' } }).quickLaunch).toEqual({ shortcut: '', afterLaunch: 'flowdeck' });
    expect(() => h.core.updateSettings({ quickLaunch: { shortcut: 'F' } })).toThrow();
    h.core.updateSettings({ quickLaunch: { shortcut: 'Control+Alt+F', afterLaunch: 'stay' } });
  });

  it('refused launches leave no node and no tmux session behind', async () => {
    const before = h.repo.listNodes().length;
    const panes = (await sessions()).length;
    await expect(h.core.createNode({ kind: 'claude', title: 'x', cwd: project, accountId: 'default', task: 'mcp' })).rejects.toThrow(
      /subcommand/,
    );
    // fits the schema, but not tmux once the arguments are added
    const longArgs = Array.from({ length: 16 }, () => `--add-dir=/${'d'.repeat(188)}`);
    await expect(
      h.core.createNode({ kind: 'claude', title: 'y', cwd: project, accountId: 'default', launchArgs: longArgs, task: 'x '.repeat(6 * 1024) }),
    ).rejects.toThrow(/too long for tmux/);
    expect(h.repo.listNodes()).toHaveLength(before);
    expect(await sessions()).toHaveLength(panes);
  });
});
