import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NodeState, NodeView } from '@flowdeck/shared';
import { AppClient } from '../../../mcp/src/client';
import { createHarness, waitFor, type Harness } from '../helpers';

/** Codex (hooks via -c, lazy session id) and Kiro (terminal activity) with real tmux. */
describe('Codex and Kiro nodes', () => {
  let h: Harness;
  let claude: NodeView;
  let codex: NodeView;
  let kiro: NodeView;

  const state = (id: string): NodeState => h.repo.getStatus(id).state;
  const waitState = (id: string, s: NodeState, ms = 10_000) => waitFor(() => state(id) === s, ms);
  /** Activity status needs the liveness poll; tests drive it explicitly. */
  const waitPolled = (id: string, s: NodeState, ms = 15_000) =>
    waitFor(async () => {
      await h.core.checkPanes();
      return state(id) === s;
    }, ms, 250);
  const type = (id: string, text: string) => h.tmux.pasteAndSubmit(h.repo.getNode(id)!.tmuxSession, text, 50);
  const log = () => readFileSync(h.logFile, 'utf8');
  const codexPrompts = (id: string) => {
    const sid = h.repo.getNode(id)!.sessionId;
    const file = join(h.home, '.codex', 'fake-sessions', `${sid}.jsonl.prompts`);
    return sid && existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const screen = (id: string) => h.tmux.capture(h.repo.getNode(id)!.tmuxSession, 200);
  const client = (id: string) => {
    const n = h.repo.getNode(id)!;
    return new AppClient({ nodeId: n.id, token: n.token, socketPath: h.runtime.paths.socketPath });
  };

  beforeAll(async () => {
    h = await createHarness();
    h.core.upsertAccount({ id: 'default', label: 'Claude', configDir: join(h.home, '.claude'), color: '#7c6cf2' });
    h.core.upsertAccount({ id: 'codex', agent: 'codex', label: 'Codex', configDir: join(h.home, '.codex'), color: '#3cb4f2' });
    claude = await h.core.createNode({ kind: 'claude', title: 'lead', cwd: h.home, accountId: 'default' });
    codex = await h.core.createNode({ kind: 'codex', title: 'coder', cwd: h.home, accountId: 'codex' });
    kiro = await h.core.createNode({ kind: 'kiro', title: 'kiro', cwd: h.home, accountId: null });
    await waitState(claude.id, 'idle');
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('Codex launches with hooks and MCP as -c overrides, its default home and no API keys', () => {
    // not deliverable until Codex shows it is past any start-up dialog
    expect(codex.status).toMatchObject({ state: 'starting', detail: expect.stringContaining('first prompt') });
    const args = log().split('\n').find((l) => l.startsWith('ARGS codex'))!;
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt']) {
      expect(args).toContain(`hooks.${event}=`);
    }
    expect(args).toContain('mcp_servers.flowdeck.args=');
    expect(args).toContain('--identity');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
    expect(args).not.toContain(h.repo.getNode(codex.id)!.token);
    expect(log()).toContain(`ENV codex node=${codex.id} identity=set token= config=<unset> codex_home=<unset> apikey= `);
  });

  it('no node token ever appears in a command line (tmux keeps its first one for its lifetime)', async () => {
    const pid = (await h.tmux.run(['display-message', '-p', '#{pid}'])).stdout.trim();
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    for (const n of h.repo.listNodes()) expect(cmdline).not.toContain(n.token);
    expect(log()).not.toContain('token=leaked');
    for (const n of h.repo.listNodes()) expect(log()).not.toContain(n.token);
  });

  it('a message to a Codex node that has not signalled readiness waits in the queue', async () => {
    h.core.createEdge({ source: claude.id, target: codex.id, direction: 'one_way' });
    const sent = await client(claude.id).sendTo('coder', 'early bird');
    expect(sent.status).toBe('queued');
    expect(codexPrompts(codex.id)).toBe('');
    const edge = h.repo.edgesOf(claude.id).find((e) => e.target === codex.id)!;
    h.core.deleteEdge(edge.id); // drops the queued message; later tests draw their own edges
    h.core.onHook(codex.id, 'Stop', {}); // fake readiness only to flush the revoked message
    await waitFor(() => h.repo.listMessages().find((m) => m.id === sent.messageId)?.delivered);
  });

  it('every launch gets a fresh token, so a token exposed earlier stops working', async () => {
    const before = h.repo.getNode(claude.id)!.token;
    await h.core.restartNode(claude.id);
    await waitState(claude.id, 'idle');
    const after = h.repo.getNode(claude.id)!.token;
    expect(after).not.toBe(before);
    const stale = new AppClient({ nodeId: claude.id, token: before, socketPath: h.runtime.paths.socketPath });
    await expect(stale.listPeers()).rejects.toThrow(/forbidden/);
    await expect(client(claude.id).listPeers()).resolves.toBeDefined();
  });

  it('Kiro gets no FlowDeck identity, MCP config or account', () => {
    expect(kiro.accountId).toBeNull();
    expect(log()).toContain('ENV kiro node= identity= token= ');
    expect(existsSync(join(h.runtime.paths.nodesDir, kiro.id, 'identity.json'))).toBe(false);
  });

  it('Codex reveals its session id with the first prompt; working → idle', async () => {
    expect(h.repo.getNode(codex.id)!.sessionId).toBeNull();
    await type(codex.id, 'SLOW refactor');
    await waitState(codex.id, 'working', 3000);
    await waitState(codex.id, 'idle', 8000);
    expect(h.repo.getNode(codex.id)!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.notifications.some((n) => n.nodeId === codex.id && n.title === 'coder finished')).toBe(true);
  });

  it('Codex PermissionRequest → needs_input with what it wants to do; Interrupt → idle', async () => {
    await type(codex.id, 'PERMISSION tests');
    await waitState(codex.id, 'needs_input');
    expect(h.repo.getStatus(codex.id).detail).toBe('Approval needed: run the test suite');
    await type(codex.id, 'y');
    await waitState(codex.id, 'idle');
    await type(codex.id, 'INTERRUPT this');
    await waitFor(() => codexPrompts(codex.id).includes('INTERRUPT this'));
    await waitState(codex.id, 'idle');
  });

  it('Kiro state follows terminal activity: output → working, quiet → idle', async () => {
    await waitPolled(kiro.id, 'idle');
    await type(kiro.id, 'SLOW build it');
    await waitPolled(kiro.id, 'working', 6000);
    await waitPolled(kiro.id, 'idle', 15_000);
  }, 30_000);

  it('agents of different kinds message each other along edges', async () => {
    h.core.createEdge({ source: claude.id, target: codex.id, direction: 'both' });
    h.core.createEdge({ source: claude.id, target: kiro.id, direction: 'one_way' });

    // Codex → Claude through flowdeck-mcp's API
    expect((await client(codex.id).sendTo('lead', 'patch ready')).status).toBe('delivered');
    // Claude → Codex and Claude → Kiro (Kiro cannot send: it has no MCP)
    await waitState(claude.id, 'idle');
    expect((await client(claude.id).sendTo('coder', 'please add tests')).status).toBe('delivered');
    await waitFor(() => codexPrompts(codex.id).includes('[from: lead] please add tests'));
    await waitState(codex.id, 'idle');
    await waitPolled(kiro.id, 'idle');
    expect((await client(claude.id).sendTo('kiro', 'summarise the diff')).status).toBe('delivered');
    await waitFor(async () => (await screen(kiro.id)).includes('[from: lead] summarise the diff'));
  }, 30_000);

  it('skip-approval Codex nodes are detected (flags and config.toml) and protected', async () => {
    const flagged = await h.core.createNode({ kind: 'codex', title: 'yolo', cwd: h.home, accountId: 'codex', launchArgs: ['-a', 'never'] });
    expect(flagged.dangerous).toBe(true);
    expect(() => h.core.createEdge({ source: claude.id, target: flagged.id, direction: 'one_way' })).toThrow(/skips permissions/);
    await h.core.deleteNode(flagged.id);

    const project = join(h.home, 'auto-project');
    mkdirSync(join(project, '.codex'), { recursive: true });
    writeFileSync(join(project, '.codex', 'config.toml'), 'approval_policy = "never"\n[tui]\nx = 1\n');
    const byConfig = await h.core.createNode({ kind: 'codex', title: 'auto', cwd: project, accountId: 'codex' });
    expect(byConfig.dangerous).toBe(true);
    await h.core.deleteNode(byConfig.id);

    const kiroAll = await h.core.createNode({ kind: 'kiro', title: 'k2', cwd: h.home, accountId: null, launchArgs: ['--trust-all-tools'] });
    expect(kiroAll.dangerous).toBe(true);
    await h.core.deleteNode(kiroAll.id);
  });

  it('FlowDeck-owned options cannot be passed to Codex or Kiro', async () => {
    const bad: [string, string[]][] = [
      ['codex', ['-c', 'hooks.Stop=[]']],
      ['codex', ['--config=mcp_servers.flowdeck.command="x"']],
      ['codex', ['--dangerously-bypass-hook-trust']],
      ['codex', ['--disable', 'hooks']],
      ['codex', ['resume']],
      ['kiro', ['--resume-id', 'x']],
      ['kiro', ['agent']],
    ];
    for (const [kind, launchArgs] of bad) {
      await expect(
        h.core.createNode({ kind, title: 'x', cwd: h.home, accountId: kind === 'codex' ? 'codex' : null, launchArgs }),
      ).rejects.toThrow(/managed by FlowDeck/);
    }
    // an account of the wrong agent is refused
    await expect(h.core.createNode({ kind: 'codex', title: 'x', cwd: h.home, accountId: 'default' })).rejects.toThrow(
      /not a Codex account/,
    );
  });

  it('a non-default Codex home is selected with CODEX_HOME', async () => {
    mkdirSync(join(h.home, '.codex-work'), { recursive: true });
    const discovered = h.core.discoverAccounts();
    expect(discovered.find((d) => d.configDir.endsWith('.codex-work'))).toMatchObject({ agent: 'codex', suggestedId: 'codex-work' });
    h.core.upsertAccount({ id: 'codex-work', agent: 'codex', label: 'Codex work', configDir: join(h.home, '.codex-work'), color: '#4fc47a' });
    const n = await h.core.createNode({ kind: 'codex', title: 'work', cwd: h.home, accountId: 'codex-work' });
    expect(log()).toContain(`ENV codex node=${n.id} identity=set token= config=<unset> codex_home=${join(h.home, '.codex-work')} `);
    await h.core.deleteNode(n.id);
  });

  it('duplicate clones type, directory, account and arguments into a new session', async () => {
    const copy = await h.core.duplicateNode(codex.id);
    expect(copy).toMatchObject({ kind: 'codex', cwd: codex.cwd, accountId: 'codex', title: 'coder #2', y: codex.y });
    expect(copy.x).toBe(codex.x + codex.w + 40);
    expect(copy.id).not.toBe(codex.id);
    expect(h.repo.getNode(copy.id)!.sessionId).toBeNull();
    const again = await h.core.duplicateNode(copy.id);
    expect(again.title).toBe('coder #3');
    await h.core.deleteNode(copy.id);
    await h.core.deleteNode(again.id);
  });

  it('after a reboot Codex resumes its session and Kiro its latest conversation', async () => {
    const codexSession = h.repo.getNode(codex.id)!.sessionId!;
    await h.core.stop();
    await h.tmux.killServer();
    writeFileSync(h.logFile, '');
    await h.restart();
    await waitState(claude.id, 'idle');
    const lines = log().split('\n');
    expect(lines.find((l) => l.startsWith('ARGS codex'))).toContain(`resume ${codexSession}`);
    expect(lines.find((l) => l.startsWith('ARGS kiro'))).toContain('chat --resume');
  });
});
