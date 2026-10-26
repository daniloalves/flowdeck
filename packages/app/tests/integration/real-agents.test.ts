import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventApi, EventChannel } from '@flowdeck/shared';
import { Core } from '../../src/main/core';
import { openDatabase } from '../../src/main/db/database';
import { Repo } from '../../src/main/db/repo';
import { installRuntimeFiles, resolveRuntime } from '../../src/main/runtime';
import { sanitizeEnv } from '../../src/main/tmux/env';
import { Tmux } from '../../src/main/tmux/tmux';
import { MCP_BUNDLE, RESOURCES, removeTmuxSocket, tempDir, waitFor } from '../helpers';

/**
 * Opt-in smoke tests against the installed CLIs and the user's default accounts:
 *   FLOWDECK_REAL_AGENTS=1 pnpm --filter @flowdeck/app test -- real-agents
 * No prompt is sent, so no tokens are used, and Codex hook trust is not recorded.
 * Claude: hooks from --settings fire, MCP from --mcp-config connects.
 * Codex: hooks from -c are discovered, MCP from -c connects through --identity.
 */
describe.skipIf(!process.env.FLOWDECK_REAL_AGENTS)('real agent CLIs', () => {
  const root = tempDir('fdreal');
  const home = process.env.HOME!;
  const socket = `fdreal-${process.pid}`;
  const runtime = resolveRuntime({ HOME: home, FLOWDECK_DATA_DIR: join(root, 'data'), FLOWDECK_SOCK_PATH: join(root, 'fd.sock'), FLOWDECK_TMUX_SOCKET: socket });
  mkdirSync(runtime.paths.dataDir, { recursive: true });
  installRuntimeFiles(runtime.paths, RESOURCES, MCP_BUNDLE);
  const tmux = new Tmux({ bin: 'tmux', socket, confFile: runtime.paths.tmuxConf, env: sanitizeEnv(process.env) });
  const db = openDatabase(runtime.paths.dbFile);
  const repo = new Repo(db);
  const bin = (name: string) => execFileSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim();
  const core = new Core({
    repo,
    tmux,
    paths: runtime.paths,
    home,
    agentBins: { claude: bin('claude'), codex: bin('codex') },
    shellBin: '/bin/bash',
    mcpRunner: { command: process.execPath, args: [runtime.paths.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1' } },
    emit: <C extends EventChannel>(_c: C, _p: EventApi[C]) => undefined,
    notifier: { notify: () => undefined },
    isAppFocused: () => true,
    paneIntervalMs: 0,
    usageIntervalMs: 0,
  });

  afterAll(async () => {
    await core.stop();
    db.close();
    await tmux.killServer();
    removeTmuxSocket(socket);
    rmSync(root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    await core.start();
  });

  it('Claude: SessionStart arrives through --settings and flowdeck-mcp connects through --mcp-config', async () => {
    core.upsertAccount({ id: 'default', label: 'Default', configDir: join(home, '.claude'), color: '#7c6cf2' });
    const cwd = resolve(__dirname, '../../../..');
    const node = await core.createNode({ kind: 'claude', title: 'smoke', cwd, accountId: 'default' });
    const assigned = node.sessionId;

    await waitFor(() => repo.getStatus(node.id).state === 'idle', 45_000, 250);
    expect(repo.getNode(node.id)!.sessionId).toBe(assigned);

    await tmux.pasteAndSubmit(node.tmuxSession, '/mcp', 300);
    let screen = '';
    await waitFor(async () => {
      screen = await tmux.capture(node.tmuxSession, 80);
      return /✔ flowdeck\s+3 tools/.test(screen);
    }, 30_000, 500).catch(() => undefined);
    expect(screen, screen).toMatch(/✔ flowdeck\s+3 tools/);
    await core.deleteNode(node.id);
  }, 120_000);

  it('Codex: -c hooks are discovered and flowdeck-mcp connects through --identity', async () => {
    core.upsertAccount({ id: 'codex', agent: 'codex', label: 'Codex', configDir: join(home, '.codex'), color: '#3cb4f2' });
    const node = await core.createNode({ kind: 'codex', title: 'smoke-codex', cwd: home, accountId: 'codex' });
    const capture = () => tmux.capture(node.tmuxSession, 80);
    let screen = '';
    await waitFor(async () => {
      screen = await capture();
      return /Hooks need review|Ask Codex/i.test(screen);
    }, 45_000, 500);
    if (/Hooks need review/i.test(screen)) {
      // proves Codex parsed the -c hooks; leave without trusting (nothing is persisted)
      const menu = screen.split('\n').filter((l) => /^\s*›?\s*\d\./.test(l));
      const target = menu.findIndex((l) => /Continue without trusting/i.test(l));
      const current = menu.findIndex((l) => l.includes('›'));
      const keys = Array<string>(Math.max(0, target - Math.max(0, current))).fill('Down');
      await tmux.run(['send-keys', '-t', `=${node.tmuxSession}:`, ...keys, 'Enter']);
    }
    await waitFor(async () => /Ask Codex/.test(await capture()), 30_000, 500);
    // slash commands must be typed (a bracketed paste does not open Codex's command menu)
    const command = async (cmd: string) => {
      await tmux.run(['send-keys', '-t', `=${node.tmuxSession}:`, '-l', cmd]);
      await new Promise((r) => setTimeout(r, 500));
      await tmux.run(['send-keys', '-t', `=${node.tmuxSession}:`, 'Enter']);
    };
    // the hook browser lists every FlowDeck hook as installed: proof the -c hooks were parsed
    await command('/hooks');
    await waitFor(async () => {
      screen = await capture();
      return ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse'].every((e) =>
        new RegExp(`${e}\\s+1\\s`).test(screen),
      );
    }, 30_000, 500);
    await tmux.run(['send-keys', '-t', `=${node.tmuxSession}:`, 'Escape']);
    await new Promise((r) => setTimeout(r, 500));
    await tmux.run(['send-keys', '-t', `=${node.tmuxSession}:`, 'C-u']); // clear the composer
    await new Promise((r) => setTimeout(r, 300));
    await command('/mcp');
    await waitFor(async () => {
      screen = await capture();
      return /flowdeck: connected \(3 tools\)/.test(screen);
    }, 30_000, 500).catch(() => undefined);
    expect(screen, screen).toMatch(/flowdeck: connected \(3 tools\)/);
    await core.deleteNode(node.id);
  }, 150_000);
});
