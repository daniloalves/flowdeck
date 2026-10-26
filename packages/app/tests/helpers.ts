import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core, type Notifier } from '../src/main/core';
import { openDatabase, type Db } from '../src/main/db/database';
import { Repo } from '../src/main/db/repo';
import { installRuntimeFiles, resolveRuntime, type RuntimeEnv } from '../src/main/runtime';
import { sanitizeEnv } from '../src/main/tmux/env';
import { Tmux } from '../src/main/tmux/tmux';
import type { AgentKind, EventApi, EventChannel } from '@flowdeck/shared';

export const APP_DIR = resolve(__dirname, '..');
export const RESOURCES = join(APP_DIR, 'resources');
export const MCP_BUNDLE = resolve(APP_DIR, '../mcp/dist/flowdeck-mcp.cjs');
export const FAKE_CLAUDE = join(APP_DIR, 'tests/fixtures/fake-claude.sh');
export const FAKE_CODEX = join(APP_DIR, 'tests/fixtures/fake-codex.sh');
export const FAKE_KIRO = join(APP_DIR, 'tests/fixtures/fake-kiro.sh');

/** tmux leaves its socket file behind after kill-server; tests remove it. */
export function removeTmuxSocket(name: string): void {
  const dir = process.env.TMUX_TMPDIR ?? '/tmp';
  rmSync(join(dir, `tmux-${process.getuid?.() ?? 0}`, name), { force: true });
}

/** Short temp dir (Unix socket paths are limited to 108 bytes). */
export function tempDir(prefix = 'fd'): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, stepMs = 50): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export interface Harness {
  root: string;
  home: string;
  runtime: RuntimeEnv;
  db: Db;
  repo: Repo;
  tmux: Tmux;
  core: Core;
  events: { channel: EventChannel; payload: unknown }[];
  notifications: { title: string; body: string; nodeId: string }[];
  logFile: string;
  /** Builds a second Core over the same data (simulates an app restart). */
  restart(): Promise<Core>;
  cleanup(): Promise<void>;
}

export async function createHarness(
  opts: { tmuxSocket?: string; agentBins?: Partial<Record<AgentKind, string | null>> } = {},
): Promise<Harness> {
  const root = tempDir();
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude-work'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const logFile = join(root, 'fake-agent.log');
  const socket = opts.tmuxSocket ?? `fdtest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const runtime = resolveRuntime({
    HOME: home,
    FLOWDECK_DATA_DIR: join(root, 'data'),
    FLOWDECK_SOCK_PATH: join(root, 'fd.sock'),
    FLOWDECK_TMUX_SOCKET: socket,
  });
  installRuntimeFiles(runtime.paths, RESOURCES, MCP_BUNDLE);

  // A key in the parent environment must never reach the nodes.
  const parentEnv = { ...process.env, HOME: home, ANTHROPIC_API_KEY: 'sk-should-be-stripped', OPENAI_API_KEY: 'sk-should-be-stripped', CODEX_HOME: '/wrong', FAKE_AGENT_LOG: logFile };
  const tmux = new Tmux({ bin: 'tmux', socket, confFile: runtime.paths.tmuxConf, env: sanitizeEnv(parentEnv) });

  const events: Harness['events'] = [];
  const notifications: Harness['notifications'] = [];
  const notifier: Notifier = { notify: (title, body, nodeId) => notifications.push({ title, body, nodeId }) };

  const makeCore = (repo: Repo): Core =>
    new Core({
      repo,
      tmux,
      paths: runtime.paths,
      home,
      agentBins: opts.agentBins ?? { claude: FAKE_CLAUDE, codex: FAKE_CODEX, kiro: FAKE_KIRO },
      shellBin: '/bin/bash',
      mcpRunner: { command: process.execPath, args: [runtime.paths.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1' } },
      emit: <C extends EventChannel>(channel: C, payload: EventApi[C]) => events.push({ channel, payload }),
      notifier,
      isAppFocused: () => false,
      paneIntervalMs: 0,
      usageIntervalMs: 0,
    });

  let db = openDatabase(runtime.paths.dbFile);
  let repo = new Repo(db);
  let core = makeCore(repo);
  await core.start();

  const h: Harness = {
    root,
    home,
    runtime,
    db,
    repo,
    tmux,
    core,
    events,
    notifications,
    logFile,
    async restart() {
      await h.core.stop();
      h.db.close();
      db = openDatabase(runtime.paths.dbFile);
      repo = new Repo(db);
      core = makeCore(repo);
      h.db = db;
      h.repo = repo;
      h.core = core;
      await core.start();
      return core;
    },
    async cleanup() {
      await h.core.stop().catch(() => undefined);
      h.db.close();
      await tmux.killServer().catch(() => undefined);
      removeTmuxSocket(socket);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}
