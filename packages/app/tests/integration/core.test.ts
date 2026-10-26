import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NodeState, NodeView } from '@flowdeck/shared';
import { AppClient } from '../../../mcp/src/client';
import { createHarness, waitFor, type Harness } from '../helpers';

/**
 * End-to-end through the real pieces except Claude itself: Core → tmux (dedicated socket) →
 * fake-claude → hook.sh → Unix socket → state machine → delivery via tmux.
 */
describe('Core with real tmux and the hook pipeline', () => {
  let h: Harness;
  const nodes: Record<string, NodeView> = {};

  const state = (id: string): NodeState => h.repo.getStatus(id).state;
  const waitState = (id: string, s: NodeState, ms = 10_000) => waitFor(() => state(id) === s, ms);
  const prompts = (id: string): string => {
    const n = h.repo.getNode(id)!;
    const account = h.repo.getAccount(n.accountId!)!;
    const file = join(account.configDir, 'projects', '-fake-project', `${n.sessionId}.jsonl.prompts`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const type = (id: string, text: string) => h.tmux.pasteAndSubmit(h.repo.getNode(id)!.tmuxSession, text, 50);
  const client = (id: string) => {
    const n = h.repo.getNode(id)!;
    return new AppClient({ nodeId: n.id, token: n.token, socketPath: h.runtime.paths.socketPath });
  };

  beforeAll(async () => {
    h = await createHarness();
    h.core.upsertAccount({ id: 'default', label: 'Personal', configDir: join(h.home, '.claude'), color: '#7c6cf2' });
    h.core.upsertAccount({ id: 'work', label: 'Work', configDir: join(h.home, '.claude-work'), color: '#f2a33c' });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('criterion 1: six Claude sessions on two accounts start and report idle', async () => {
    const specs = [
      ['leader', 'default'],
      ['reviewer', 'work'],
      ['tester', 'work'],
      ['writer', 'default'],
      ['ops', 'work'],
      ['spare', 'default'],
    ] as const;
    for (const [title, accountId] of specs) {
      nodes[title] = await h.core.createNode({ kind: 'claude', title, cwd: h.home, accountId });
    }
    for (const n of Object.values(nodes)) await waitState(n.id, 'idle');

    const panes = await h.tmux.listPanes();
    expect(panes!.filter((p) => !p.dead)).toHaveLength(6);

    const log = readFileSync(h.logFile, 'utf8');
    // every launch gets FlowDeck's session id, settings and per-node MCP config
    // (--mcp-config is variadic, so it comes first and user arguments come last)
    expect(log.match(/--mcp-config \S+mcp\.json --settings \S+claude-settings\.json --session-id [0-9a-f-]{36}/g)).toHaveLength(6);
    // default account: no CLAUDE_CONFIG_DIR; work account: its own dir; API key never leaks
    expect(log).toContain(`ENV claude node=${nodes.leader!.id} identity=set token= config=<unset> codex_home=<unset> apikey= `);
    expect(log).toContain(`ENV claude node=${nodes.reviewer!.id} identity=set token= config=${join(h.home, '.claude-work')} codex_home=<unset> apikey= `);
  });

  it('per-node MCP config points to a private identity file; argv never holds the token', () => {
    const dir = join(h.runtime.paths.nodesDir, nodes.leader!.id);
    const cfg = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.flowdeck.args).toEqual([h.runtime.paths.mcpScript, '--identity', join(dir, 'identity.json')]);
    expect(JSON.stringify(cfg)).not.toContain(h.repo.getNode(nodes.leader!.id)!.token);
    expect(statSync(join(dir, 'identity.json')).mode & 0o777).toBe(0o600);
    const identity = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
    expect(identity).toEqual({
      nodeId: nodes.leader!.id,
      token: h.repo.getNode(nodes.leader!.id)!.token,
      socketPath: h.runtime.paths.socketPath,
    });
    expect(readFileSync(h.logFile, 'utf8')).not.toContain(identity.token);
  });

  it('criterion 2: prompt → working → idle with a "finished" notification', async () => {
    const id = nodes.writer!.id;
    await type(id, 'SLOW write docs');
    await waitState(id, 'working', 3000);
    await waitState(id, 'idle', 8000);
    expect(h.notifications.some((n) => n.nodeId === id && n.title === 'writer finished')).toBe(true);
  });

  it('criterion 2: a permission request turns the node needs_input, approval resumes work', async () => {
    const id = nodes.tester!.id;
    await type(id, 'PERMISSION run tests');
    await waitState(id, 'needs_input');
    expect(h.repo.getStatus(id).detail).toContain('permission');
    expect(h.notifications.some((n) => n.nodeId === id && n.title === 'tester needs input')).toBe(true);
    await type(id, 'yes');
    await waitState(id, 'idle');
  });

  it('criterion 4: leader → busy reviewer is queued, delivered only after Stop, and logged', async () => {
    const leader = nodes.leader!.id;
    const reviewer = nodes.reviewer!.id;
    h.core.createEdge({ source: leader, target: reviewer, direction: 'one_way' });

    const peers = await client(leader).listPeers();
    expect(peers).toEqual([expect.objectContaining({ id: reviewer, title: 'reviewer', account: 'Work', canSend: true, canReceive: false })]);

    await type(reviewer, 'SLOW long review');
    await waitState(reviewer, 'working', 3000);
    const sent = await client(leader).sendTo('reviewer', 'please review PR 42');
    expect(sent.status).toBe('queued');
    expect(prompts(reviewer)).not.toContain('please review PR 42');
    expect(h.repo.countPendingFor(reviewer)).toBe(1);

    await waitFor(() => prompts(reviewer).includes('[from: leader] please review PR 42'), 10_000);
    const logged = h.repo.listMessages().find((m) => m.id === sent.messageId)!;
    expect(logged).toMatchObject({ fromTitle: 'leader', toTitle: 'reviewer', delivered: true, delivery: 'pty' });
    await waitState(reviewer, 'idle');
  });

  it('sending to an idle peer types the message immediately', async () => {
    const leader = nodes.leader!.id;
    const ops = nodes.ops!.id;
    h.core.createEdge({ source: leader, target: ops, direction: 'both' });
    const sent = await client(ops).sendTo(leader, 'deploy done');
    expect(sent.status).toBe('delivered');
    await waitFor(() => prompts(leader).includes('[from: ops] deploy done'));
    await waitState(leader, 'idle');
  });

  it('security: no edge, wrong direction, wrong token and oversize are refused', async () => {
    const leader = nodes.leader!.id;
    const reviewer = nodes.reviewer!.id;
    // reviewer → leader on a one-way edge
    await expect(client(reviewer).sendTo('leader', 'hi')).rejects.toThrow(/does not allow/);
    // spare has no edges at all
    await expect(client(nodes.spare!.id).sendTo('leader', 'hi')).rejects.toThrow(/no connected peer/);
    // forged token
    const forged = new AppClient({ nodeId: leader, token: 'f'.repeat(64), socketPath: h.runtime.paths.socketPath });
    await expect(forged.sendTo('reviewer', 'hi')).rejects.toThrow(/forbidden/);
    // 4,000 character limit
    await expect(client(leader).sendTo('reviewer', 'x'.repeat(4001))).rejects.toThrow(/1-4000/);
  });

  it('security: messages are sanitised before reaching the terminal', async () => {
    const leader = nodes.leader!.id;
    const reviewer = nodes.reviewer!.id;
    await client(leader).sendTo('reviewer', 'clean\x1b[2Jme\x07 up');
    await waitFor(() => prompts(reviewer).includes('[from: leader] clean[2Jme up'));
    await waitState(reviewer, 'idle');
  });

  it('concurrent deliveries to different nodes never swap text', async () => {
    const leader = nodes.leader!.id;
    const [a, b] = await Promise.all([
      client(leader).sendTo('reviewer', 'only for the reviewer'),
      client(leader).sendTo('ops', 'only for ops'),
    ]);
    expect([a.status, b.status]).toEqual(['delivered', 'delivered']);
    await waitFor(() => prompts(nodes.reviewer!.id).includes('only for the reviewer'));
    await waitFor(() => prompts(nodes.ops!.id).includes('only for ops'));
    expect(prompts(nodes.reviewer!.id)).not.toContain('only for ops');
    expect(prompts(nodes.ops!.id)).not.toContain('only for the reviewer');
    await waitState(nodes.reviewer!.id, 'idle');
    await waitState(nodes.ops!.id, 'idle');
  });

  it('cutting an edge drops the messages still queued on it', async () => {
    const leader = nodes.leader!.id;
    const reviewer = nodes.reviewer!.id;
    h.repo.setStatus(reviewer, { state: 'working', detail: null, updatedAt: Date.now() });
    const sent = await client(leader).sendTo('reviewer', 'must never arrive');
    expect(sent.status).toBe('queued');
    const edge = h.repo.edgesOf(leader).find((e) => e.target === reviewer)!;
    h.core.deleteEdge(edge.id);
    h.core.onHook(reviewer, 'Stop', {});
    await waitFor(() => h.repo.listMessages().find((m) => m.id === sent.messageId)?.delivered);
    expect(h.repo.listMessages().find((m) => m.id === sent.messageId)).toMatchObject({ delivered: true, delivery: null });
    expect(prompts(reviewer)).not.toContain('must never arrive');
    h.core.createEdge({ source: leader, target: reviewer, direction: 'one_way' });
  });

  it('security: a node made permission-less by a settings file counts as dangerous', async () => {
    const project = join(h.home, 'yolo-project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    const yolo = await h.core.createNode({ kind: 'claude', title: 'yolo-settings', cwd: project, accountId: 'work' });
    expect(yolo.dangerous).toBe(true);
    expect(() => h.core.createEdge({ source: nodes.leader!.id, target: yolo.id, direction: 'one_way' })).toThrow(/skips permissions/);
    const viaMode = await h.core.createNode({
      kind: 'claude',
      title: 'yolo-mode',
      cwd: h.home,
      accountId: 'work',
      launchArgs: ['--permission-mode', 'bypassPermissions'],
    });
    expect(viaMode.dangerous).toBe(true);
    await h.core.deleteNode(yolo.id);
    await h.core.deleteNode(viaMode.id);
  });

  it('security: a normal node cannot be wired into a skip-permissions node', async () => {
    const yolo = await h.core.createNode({
      kind: 'claude',
      title: 'yolo',
      cwd: h.home,
      accountId: 'work',
      launchArgs: ['--dangerously-skip-permissions'],
    });
    expect(yolo.dangerous).toBe(true);
    expect(() => h.core.createEdge({ source: nodes.leader!.id, target: yolo.id, direction: 'one_way' })).toThrow(/skips permissions/);
    await h.core.deleteNode(yolo.id);
  });

  it('security: reserved flags cannot be injected through launch args', async () => {
    for (const bad of [['--settings=/tmp/evil.json'], ['-rabc'], ['--mcp-config', '/tmp/evil.json']]) {
      await expect(
        h.core.createNode({ kind: 'claude', title: 'x', cwd: h.home, accountId: 'work', launchArgs: bad }),
      ).rejects.toThrow(/managed by FlowDeck/);
    }
    await expect(h.core.createNode({ kind: 'shell', title: 'x', cwd: '/definitely/missing', accountId: null })).rejects.toThrow(
      /directory not found/,
    );
  });

  it('rate limit stops two agents from looping forever', async () => {
    const leader = nodes.leader!.id;
    const ops = nodes.ops!.id;
    // ops → leader is allowed (two-way edge); leader is made busy so messages queue
    h.repo.setStatus(leader, { state: 'working', detail: null, updatedAt: Date.now() });
    const c = client(ops);
    let limited = false;
    for (let i = 0; i < 12; i++) {
      try {
        await c.sendTo('leader', `ping ${i}`);
      } catch (err) {
        limited = /rate limit/.test(String(err));
        break;
      }
    }
    expect(limited).toBe(true);
    // read_inbox drains the queue exactly once
    const inbox = await client(leader).readInbox();
    expect(inbox.length).toBeGreaterThan(0);
    expect(await client(leader).readInbox()).toEqual([]);
    h.repo.setStatus(leader, { state: 'idle', detail: null, updatedAt: Date.now() });
  });

  it('liveness check never kills a live node from a stale or failed pane snapshot', async () => {
    const id = nodes.ops!.id;
    const real = h.tmux.listPanes.bind(h.tmux);
    try {
      // stale snapshot taken before the session existed
      h.tmux.listPanes = async () => [];
      await h.core.checkPanes();
      expect(state(id)).toBe('idle');
      // tmux error: no guessing
      h.tmux.listPanes = async () => null;
      await h.core.checkPanes();
      expect(state(id)).toBe('idle');
      // state changed while the snapshot was being taken
      h.tmux.listPanes = async () => {
        h.repo.setStatus(id, { state: 'working', detail: null, updatedAt: Date.now() + 1 });
        return [];
      };
      await h.core.checkPanes();
      expect(state(id)).toBe('working');
    } finally {
      h.tmux.listPanes = real;
      h.repo.setStatus(id, { state: 'idle', detail: null, updatedAt: Date.now() });
    }
    // creating nodes while checks run concurrently leaves them alive
    const checks = Array.from({ length: 5 }, () => h.core.checkPanes());
    const extra = await h.core.createNode({ kind: 'shell', title: 'race', cwd: h.home, accountId: null });
    await Promise.all(checks);
    await h.core.checkPanes();
    expect(state(extra.id)).toBe('idle');
    await h.core.deleteNode(extra.id);
  });

  it('a node that exits is marked dead and can be resumed in the same conversation', async () => {
    const id = nodes.spare!.id;
    const sid = h.repo.getNode(id)!.sessionId;
    await type(id, 'hello');
    await waitState(id, 'idle');
    await type(id, 'exit');
    await waitFor(async () => {
      await h.core.checkPanes();
      return state(id) === 'dead';
    });
    await h.core.restartNode(id);
    await waitState(id, 'idle');
    expect(readFileSync(h.logFile, 'utf8')).toContain(`--resume ${sid}`);
  });

  it('events that happen while the app is closed are spooled and applied on reopen', async () => {
    const id = nodes.writer!.id;
    await h.core.stop(); // app closed: socket gone, sessions keep running
    await type(id, 'PERMISSION while closed');
    const spool = join(h.runtime.paths.spoolDir, id);
    await waitFor(() => existsSync(spool) && readFileSync(spool, 'utf8').includes('Notification'));
    await h.restart();
    expect(state(id)).toBe('needs_input');
    await type(id, 'ok');
    await waitState(id, 'idle');
  });

  it('criterion 5: after a reboot (tmux server gone) every node comes back in its conversation', async () => {
    const before = h.repo.listNodes();
    const layouts = Object.fromEntries(before.map((n) => [n.id, [n.x, n.y, n.w, n.h, n.accountId]]));
    await h.core.stop();
    await h.tmux.killServer(); // what a reboot does to tmux
    writeFileSync(h.logFile, '');
    await h.restart();

    for (const n of before) await waitState(n.id, 'idle');
    const log = readFileSync(h.logFile, 'utf8');
    for (const n of h.repo.listNodes()) {
      expect([n.x, n.y, n.w, n.h, n.accountId]).toEqual(layouts[n.id]);
      // nodes that had a conversation resume it; nodes that never got a prompt reuse their id
      expect(log).toMatch(new RegExp(`--(resume|session-id) ${n.sessionId}`));
    }
    expect(log).toContain(`--resume ${h.repo.getNode(nodes.leader!.id)!.sessionId}`);
  });

  it('criterion 3: usage is computed per account from the transcripts', async () => {
    const usage = await h.core.refreshUsage();
    const work = usage.find((u) => u.accountId === 'work')!;
    const personal = usage.find((u) => u.accountId === 'default')!;
    // fake-claude writes 100 input + 50 output tokens per prompt
    expect(work.block!.inputTokens % 100).toBe(0);
    expect(work.block!.outputTokens).toBe(work.block!.inputTokens / 2);
    expect(personal.week.inputTokens).toBeGreaterThan(0);
  });

  it('groups and texts on the canvas are validated, persisted and survive a restart', async () => {
    const group = h.core.createAnnotation({ kind: 'group', text: 'Backend', color: '#5b8cff', x: -40, y: -60, w: 900, h: 500 });
    const text = h.core.createAnnotation({ kind: 'text', text: 'two\nlines', color: '#e6e6ef', x: 0, y: 600, w: 300, h: 40 });
    expect(text.fontSize).toBe(20);
    expect(h.core.updateAnnotation(group.id, { x: 10, text: 'Backend team' })).toMatchObject({ x: 10, y: -60, text: 'Backend team' });

    const invalid: unknown[] = [
      { kind: 'circle', color: '#ffffff', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'text', text: 'bell\u0007', color: '#ffffff', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'text', text: 'x'.repeat(2001), color: '#ffffff', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'group', color: 'red', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'group', color: '#ffffff', x: Infinity, y: 0, w: 100, h: 100 },
      { kind: 'group', color: '#ffffff', x: 0, y: 0, w: 1, h: 100 },
    ];
    for (const input of invalid) expect(() => h.core.createAnnotation(input)).toThrow();
    expect(() => h.core.updateAnnotation(group.id, { fontSize: 500 })).toThrow();
    expect(() => h.core.updateAnnotation('missing', { x: 1 })).toThrow(/not found/);

    const restarted = await h.restart();
    expect(restarted.snapshot().annotations.map((a) => a.text)).toEqual(['Backend team', 'two\nlines']);
    restarted.deleteAnnotation(text.id);
    expect(restarted.snapshot().annotations).toHaveLength(1);
  });

  it('scrollback: tmux scrolls to a line, reports it, and leaves it; the config reload is idempotent', async () => {
    const n = await h.core.createNode({ kind: 'shell', title: 'scroll', cwd: h.home, accountId: null });
    const t = n.tmuxSession;
    await h.tmux.run(['send-keys', '-t', `=${t}:`, 'seq 1 500', 'Enter']);
    await waitFor(async () => ((await h.tmux.scrollState(t))?.history ?? 0) > 400 || null);
    expect(await h.tmux.scrollState(t)).toMatchObject({ inMode: false, position: 0 });

    await h.tmux.scrollTo(t, 120);
    expect(await h.tmux.scrollState(t)).toMatchObject({ inMode: true, position: 120 });
    await h.tmux.leaveScrollback(t);
    expect((await h.tmux.scrollState(t))?.inMode).toBe(false);
    await h.tmux.leaveScrollback(t); // not in copy mode: harmless
    await h.tmux.scrollTo(t, 0);
    expect((await h.tmux.scrollState(t))?.inMode).toBe(false);

    await h.tmux.reloadConfig();
    await h.tmux.reloadConfig();
    const features = (await h.tmux.run(['show', '-s', 'terminal-features'])).stdout.trim().split('\n');
    expect(features.filter((f) => f.includes('xterm-256color'))).toEqual(['terminal-features[10] xterm-256color:RGB:clipboard']);
    expect((await h.tmux.run(['show', '-g', 'mode-style'])).stdout).toContain('#3d3d66');
    await h.core.deleteNode(n.id);
  });
});
