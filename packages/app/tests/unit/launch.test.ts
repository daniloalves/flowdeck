import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountEnv, discoverConfigDirs, isLoggedIn, suggestAccountId } from '../../src/main/accounts/accounts';
import { settingsSkipPermissions } from '../../src/main/accounts/permissions';
import { desktopEntry } from '../../src/main/autostart';
import { claudeStartArgs, planClaudeStart, transcriptExists } from '../../src/main/restore/restore';
import { claudeSettings, nodeMcpConfig, writePrivateFile } from '../../src/main/runtime';
import { sanitizeEnv } from '../../src/main/tmux/env';
import { execFileSync } from 'node:child_process';
import { assertSessionName, buildNewSessionArgs, CLOSE_FDS_AND_EXEC } from '../../src/main/tmux/tmux';
import { isTrustedUrl, SECURE_WEB_PREFERENCES } from '../../src/main/window';
import { tempDir } from '../helpers';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('tmux argv', () => {
  it('passes the command as separate argv elements after --', () => {
    const args = buildNewSessionArgs({
      name: 'fd-abcdef123456',
      cwd: '/tmp/my dir; rm -rf ~',
      env: { FLOWDECK_NODE_ID: 'x' },
      command: ['claude', '--resume', 'id'],
    });
    expect(args).toEqual([
      'new-session', '-d', '-s', 'fd-abcdef123456', '-c', '/tmp/my dir; rm -rf ~',
      '-e', 'FLOWDECK_NODE_ID=x', '--', 'claude', '--resume', 'id',
    ]);
  });

  it('never hands a single-word command to sh -c', () => {
    const args = buildNewSessionArgs({ name: 'fd-abcdef123456', cwd: '/', env: {}, command: ['/bin/bash'] });
    expect(args.slice(-2)).toEqual(['/usr/bin/env', '/bin/bash']);
  });

  it('rejects unsafe session names and env keys', () => {
    expect(() => assertSessionName('fd-x;kill')).toThrow();
    expect(() => assertSessionName('other')).toThrow();
    expect(() =>
      buildNewSessionArgs({ name: 'fd-abcdef123456', cwd: '/', env: { 'A=B': 'x' }, command: ['a', 'b'] }),
    ).toThrow();
  });
});

describe('tmux server start', () => {
  it('drops inherited descriptors (Chromium leaves some without CLOEXEC)', () => {
    // fd 9 and 200 stand in for leaked Electron descriptors
    const out = execFileSync(
      '/bin/bash',
      ['-c', 'exec 9>/dev/null 200</dev/null; exec /bin/bash -c "$0" flowdeck-tmux ls /proc/self/fd', CLOSE_FDS_AND_EXEC],
      { encoding: 'utf8' },
    );
    const fds = out.split(/\s+/).filter(Boolean).map(Number);
    expect(fds).not.toContain(9);
    expect(fds).not.toContain(200);
    expect(fds).toEqual(expect.arrayContaining([0, 1, 2]));
  });
});

describe('environment sanitisation', () => {
  it('drops API keys, config dir and nested-Claude markers by name', () => {
    const env = sanitizeEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CONFIG_DIR: '/x',
      CLAUDECODE: '1',
      ELECTRON_RUN_AS_NODE: '1',
      FLOWDECK_NODE_TOKEN: 'leak',
      npm_config_x: 'y',
      KEEP: 'me',
    });
    expect(env).toMatchObject({ PATH: '/bin', KEEP: 'me', TERM: 'xterm-256color' });
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE', 'FLOWDECK_NODE_TOKEN', 'npm_config_x']) {
      expect(env[k]).toBeUndefined();
    }
  });
});

describe('accounts', () => {
  it('discovers ~/.claude* directories only and checks login by existence', () => {
    dir = tempDir();
    mkdirSync(join(dir, '.claude'));
    mkdirSync(join(dir, '.claude-work'));
    mkdirSync(join(dir, '.clauderc-not-matching'));
    writeFileSync(join(dir, '.claude.json'), '{}');
    writeFileSync(join(dir, '.claude-work', '.credentials.json'), 'secret');
    const found = discoverConfigDirs(dir, []);
    expect(found.map((d) => d.suggestedId)).toEqual(['default', 'work']);
    expect(found.find((d) => d.suggestedId === 'work')?.loggedIn).toBe(true);
    expect(isLoggedIn(join(dir, '.claude'))).toBe(false);
  });

  it('does not set CLAUDE_CONFIG_DIR for the default directory', () => {
    expect(accountEnv('/home/u/.claude', '/home/u')).toEqual({});
    expect(accountEnv('/home/u/.claude-work', '/home/u')).toEqual({ CLAUDE_CONFIG_DIR: '/home/u/.claude-work' });
    expect(suggestAccountId('/home/u/.claude-Personal', '/home/u')).toBe('personal');
  });
});

describe('settings-based bypass mode', () => {
  it('detects defaultMode: bypassPermissions in account or project settings', () => {
    dir = tempDir();
    const config = join(dir, 'cfg');
    const project = join(dir, 'proj');
    mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(config);
    expect(settingsSkipPermissions(config, project)).toBe(false);
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    expect(settingsSkipPermissions(config, project)).toBe(true);
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{not json');
    writeFileSync(join(config, 'settings.json'), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    expect(settingsSkipPermissions(config, project)).toBe(true);
  });
});

describe('restore planning', () => {
  const base = { id: 'n1', kind: 'claude' as const, cwd: '/p', accountId: 'a', sessionId: 'sid' };
  const other = { id: 'n2', kind: 'claude' as const, cwd: '/p', accountId: 'a' };

  it('resumes when the transcript exists', () => {
    expect(planClaudeStart(base, [], () => true, () => 'new')).toEqual({ mode: 'resume', sessionId: 'sid' });
  });

  it('reuses the id with --session-id when no prompt was ever sent', () => {
    expect(planClaudeStart(base, [], () => false, () => 'new')).toEqual({ mode: 'new', sessionId: 'sid' });
  });

  it('uses --continue only when no other node shares cwd + account', () => {
    const legacy = { ...base, sessionId: null };
    expect(planClaudeStart(legacy, [], () => false, () => 'x')).toEqual({ mode: 'continue' });
    expect(planClaudeStart(legacy, [other], () => false, () => 'x')).toEqual({ mode: 'new', sessionId: 'x' });
  });

  it('maps plans to flags', () => {
    expect(claudeStartArgs({ mode: 'resume', sessionId: 's' })).toEqual(['--resume', 's']);
    expect(claudeStartArgs({ mode: 'new', sessionId: 's' })).toEqual(['--session-id', 's']);
  });

  it('finds transcripts by name only', () => {
    dir = tempDir();
    mkdirSync(join(dir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-p', 'abc.jsonl'), '');
    expect(transcriptExists(dir, 'abc')).toBe(true);
    expect(transcriptExists(dir, 'nope')).toBe(false);
  });
});

describe('generated runtime files', () => {
  it('claude settings call the hook relay for every event, path quoted', () => {
    const s = JSON.parse(claudeSettings("/home/o'neil/hook.sh")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(s.hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
    expect(s.hooks.Stop?.[0]?.hooks[0]?.command).toBe(`'/home/o'\\''neil/hook.sh' Stop`);
  });

  it('per-node MCP config carries the identity in env', () => {
    const c = JSON.parse(nodeMcpConfig({ command: '/app', args: ['/m.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }, { FLOWDECK_NODE_ID: 'n' }));
    expect(c.mcpServers.flowdeck).toEqual({
      type: 'stdio',
      command: '/app',
      args: ['/m.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', FLOWDECK_NODE_ID: 'n' },
    });
  });

  it('private files are 0600 in 0700 directories', () => {
    dir = tempDir();
    const f = join(dir, 'a', 'b.json');
    writePrivateFile(f, '{}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o700);
    expect(readFileSync(f, 'utf8')).toBe('{}');
  });

  it('autostart entry quotes the command', () => {
    expect(desktopEntry(['/opt/Flow Deck/app', '/x"y'])).toContain('Exec="/opt/Flow Deck/app" "/x\\"y"');
  });
});

describe('electron hardening', () => {
  it('renderer runs sandboxed without Node', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it('only bundled files are trusted; the dev server is matched by origin', () => {
    expect(isTrustedUrl('https://example.com')).toBe(false);
    expect(isTrustedUrl('file:///etc/passwd')).toBe(false);
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    try {
      expect(isTrustedUrl('http://localhost:5173/index.html')).toBe(true);
      expect(isTrustedUrl('http://localhost:5173.evil.com/')).toBe(false);
    } finally {
      delete process.env.ELECTRON_RENDERER_URL;
    }
  });
});
