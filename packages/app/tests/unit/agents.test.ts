import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeArgs } from '../../src/main/agents/args';
import { tempDir } from '../helpers';
import type { NodeRecord } from '@flowdeck/shared';
import { codexAdapter } from '../../src/main/agents/codex';
import { kiroAdapter } from '../../src/main/agents/kiro';
import type { LaunchContext } from '../../src/main/agents/types';
import { transition } from '../../src/main/events/state';
import { CLAUDE_HOOK_EVENTS } from '../../src/main/runtime';

const node = (extra: Partial<NodeRecord> = {}): NodeRecord => ({
  id: 'n1',
  kind: 'codex',
  title: 't',
  cwd: '/p',
  accountId: 'codex',
  tmuxSession: 'fd-abcdef123456',
  sessionId: null,
  launchArgs: [],
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  createdAt: 0,
  ...extra,
});

const ctx = (extra: Partial<LaunchContext> = {}): LaunchContext => ({
  node: node(),
  account: { id: 'codex', agent: 'codex', label: 'C', configDir: '/home/u/.codex', color: '#ffffff', cap5h: null, cap7d: null },
  others: [],
  firstLaunch: true,
  bin: '/bin/codex',
  home: '/home/u',
  hookScript: `/data/it's "here"/hook.sh`,
  claudeSettings: '/data/claude-settings.json',
  mcpRunner: { command: '/opt/FlowDeck/flowdeck', args: ['/data/bin/flowdeck-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
  nodeDir: '/data/nodes/n1',
  identityFile: '/data/nodes/n1/identity.json',
  newId: () => 'new-id',
  ...extra,
});

describe('Codex adapter', () => {
  it('quotes the hook path for both the shell and TOML', () => {
    const { command } = codexAdapter.launch(ctx());
    const stop = command.find((a) => a.startsWith('hooks.Stop='))!;
    expect(stop).toBe(`hooks.Stop=[{hooks=[{type="command",command="'/data/it'\\\\''s \\"here\\"/hook.sh' Stop",timeout=3}]}]`);
  });

  it('chooses resume <id>, resume --last or a fresh session', () => {
    expect(codexAdapter.launch(ctx({ node: node({ sessionId: 'abc' }), firstLaunch: false })).command.slice(1, 3)).toEqual(['resume', 'abc']);
    expect(codexAdapter.launch(ctx({ firstLaunch: false })).command.slice(1, 3)).toEqual(['resume', '--last']);
    const sibling = node({ id: 'n2' });
    expect(codexAdapter.launch(ctx({ firstLaunch: false, others: [sibling] })).command[1]).toBe('-c');
    expect(codexAdapter.launch(ctx()).command[1]).toBe('-c');
  });

  it('keeps user arguments last and the default home unset', () => {
    const plan = codexAdapter.launch(ctx({ node: node({ launchArgs: ['-m', 'o3'] }) }));
    expect(plan.command.slice(-2)).toEqual(['-m', 'o3']);
    expect(plan.env).toEqual({});
    expect(plan.initialState).toBe('starting'); // deliverable only after its first hook event
  });

  it('detects every skip-approval spelling', () => {
    const cases: [string[], boolean][] = [
      [['--dangerously-bypass-approvals-and-sandbox'], true],
      [['-a', 'never'], true],
      [['--ask-for-approval=never'], true],
      [['-c', 'approval_policy="never"'], true],
      [['--approve-for-me'], true],
      [['-a', 'on-request', '-s', 'workspace-write'], false],
      [['-a', 'on-request', '-s', 'danger-full-access'], true],
      [['-m', 'never'], false],
    ];
    for (const [args, expected] of cases) expect(codexAdapter.skipsApprovals(args, { configDir: null, cwd: '/nonexistent', home: '/nonexistent' })).toBe(expected);
  });
});

describe('Kiro adapter', () => {
  it('starts a chat, resuming only after the first launch', () => {
    const k = node({ kind: 'kiro', accountId: null });
    expect(kiroAdapter.launch(ctx({ node: k, account: null })).command).toEqual(['/bin/codex', 'chat']);
    expect(kiroAdapter.launch(ctx({ node: k, account: null, firstLaunch: false })).command).toEqual(['/bin/codex', 'chat', '--resume']);
  });

  it('treats trusting shell or all tools as skipping approvals', () => {
    expect(kiroAdapter.skipsApprovals(['-a'], { configDir: null, cwd: '/nonexistent', home: '/nonexistent' })).toBe(true);
    expect(kiroAdapter.skipsApprovals(['--trust-tools=fs_read,execute_bash'], { configDir: null, cwd: '/nonexistent', home: '/nonexistent' })).toBe(true);
    expect(kiroAdapter.skipsApprovals(['--trust-tools', 'fs_read'], { configDir: null, cwd: '/nonexistent', home: '/nonexistent' })).toBe(false);
  });
});

describe('agent events', () => {
  it('Claude settings only name events Claude Code knows', () => {
    expect(CLAUDE_HOOK_EVENTS).not.toContain('PermissionRequest');
    expect(CLAUDE_HOOK_EVENTS).not.toContain('Interrupt');
  });

  it('PermissionRequest → needs_input; Interrupt → idle and drains the queue', () => {
    expect(transition('working', 'PermissionRequest', { tool_name: 'Bash' }, 'c')).toMatchObject({
      state: 'needs_input',
      detail: 'Approval needed: Bash',
    });
    expect(transition('working', 'Interrupt', {}, 'c')).toMatchObject({ state: 'idle', deliver: true, notify: null });
    expect(transition('dead', 'Interrupt', {}, 'c').state).toBeNull();
  });
});

describe('argument normalisation (clap-style)', () => {
  it('splits attached values and combined short flags', () => {
    const withValue = new Set(['-c', '-a', '-p']);
    expect(normalizeArgs(['-anever', '-a=never', '--x=1', '-chooks.Stop=[]', '-vq', '-pyolo'], withValue)).toEqual([
      '-a', 'never', '-a', 'never', '--x', '1', '-c', 'hooks.Stop=[]', '-v', '-q', '-p', 'yolo',
    ]);
  });
});

describe('review regressions', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const codex = (args: string[], configDir: string | null = null, cwd = '/nonexistent') =>
    codexAdapter.skipsApprovals(args, { configDir, cwd, home: '/nonexistent' });

  it('Codex: attached forms, sandbox and profiles are detected', () => {
    for (const args of [['-anever'], ['-a=never'], ['-capproval_policy=never'], ['-c=approval_policy="never"'], ['-s', 'danger-full-access'], ['--sandbox=danger-full-access'], ['-c', 'sandbox_mode="danger-full-access"']]) {
      expect(codex(args), args.join(' ')).toBe(true);
    }
    dir = tempDir();
    writeFileSync(join(dir, 'config.toml'), 'profile = "yolo"\n[profiles.yolo]\napproval_policy = "never"\n');
    expect(codex([], dir)).toBe(true);
    writeFileSync(join(dir, 'config.toml'), '"approval_policy" = "never"\n');
    expect(codex([], dir)).toBe(true);
    writeFileSync(join(dir, 'config.toml'), '[profiles.safe]\nmodel = "x"\n');
    writeFileSync(join(dir, 'fast.config.toml'), 'approval_policy = "never"\n');
    expect(codex(['--profile=fast'], dir)).toBe(true);
    expect(codex(['-pfast'], dir)).toBe(true);
    expect(codex(['-p', 'safe'], dir)).toBe(false);
    writeFileSync(join(dir, 'config.toml'), 'this is = = not toml');
    expect(codex([], dir)).toBe(true); // cannot tell: assume it skips approvals
  });

  it('Codex: FlowDeck-owned options cannot be smuggled in attached or whole-table forms', () => {
    for (const args of [['-chooks.Stop=[]'], ['-c=hooks.Stop=[]'], ['-c', 'mcp_servers={x={command="y"}}'], ['-c', 'mcp_servers."flowdeck".command="x"'], ['-c', 'features={codex_hooks=false}'], ['--disable=hooks'], ['--enable', 'codex_hooks']]) {
      expect(codexAdapter.reservedArgs(args), args.join(' ')).not.toBeNull();
    }
    expect(codexAdapter.reservedArgs(['-c', 'mcp_servers.github.command="gh"', '-m', 'o3'])).toBeNull();
  });

  it('Kiro: combined flags and permissive agents are detected', () => {
    dir = tempDir();
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    mkdirSync(join(home, '.kiro', 'agents'), { recursive: true });
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true });
    mkdirSync(join(project, '.kiro', 'agents'), { recursive: true });
    const kiro = (args: string[]) => kiroAdapter.skipsApprovals(args, { configDir: null, cwd: project, home });

    expect(kiro([])).toBe(false); // built-in default agent asks before running tools
    expect(kiro(['-av'])).toBe(true);
    expect(kiro(['--trust-tools=@builtin/write'])).toBe(true);
    writeFileSync(join(home, '.kiro', 'agents', 'dev.json'), '{"allowedTools":["fs_read"]}');
    expect(kiro(['--agent', 'dev'])).toBe(false);
    writeFileSync(join(project, '.kiro', 'agents', 'dev.json'), '{"allowedTools":["*"]}');
    expect(kiro(['--agent=dev'])).toBe(true); // the workspace agent wins and trusts everything
    writeFileSync(join(home, '.kiro', 'settings', 'cli.json'), '{"chat.defaultAgent":"dev"}');
    expect(kiro([])).toBe(true); // the configured default agent applies too
    expect(kiro(['--agent', 'missing'])).toBe(true); // unknown agent: assume the worst
  });
});
