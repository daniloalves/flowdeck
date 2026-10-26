import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_TMUX_SOCKET, HOOK_EVENTS } from '@flowdeck/shared';

export interface Paths {
  dataDir: string;
  dbFile: string;
  socketPath: string;
  binDir: string;
  hookScript: string;
  mcpScript: string;
  tmuxConf: string;
  claudeSettings: string;
  nodesDir: string;
  spoolDir: string;
}

export interface RuntimeEnv {
  home: string;
  paths: Paths;
  tmuxBin: string;
  tmuxSocket: string;
}

/** Resolves every location from the environment; FLOWDECK_* overrides exist for tests. */
export function resolveRuntime(env: NodeJS.ProcessEnv): RuntimeEnv {
  const home = env.HOME;
  if (!home) throw new Error('HOME is not set');
  const dataDir = env.FLOWDECK_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'flowdeck');
  const runtimeDir = env.XDG_RUNTIME_DIR ?? join(dataDir, 'run');
  const binDir = join(dataDir, 'bin');
  return {
    home,
    tmuxBin: env.FLOWDECK_TMUX_BIN ?? 'tmux',
    tmuxSocket: env.FLOWDECK_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET,
    paths: {
      dataDir,
      dbFile: join(dataDir, 'flowdeck.db'),
      socketPath: env.FLOWDECK_SOCK_PATH ?? join(runtimeDir, 'flowdeck.sock'),
      binDir,
      hookScript: join(binDir, 'hook.sh'),
      mcpScript: join(binDir, 'flowdeck-mcp.cjs'),
      tmuxConf: join(dataDir, 'tmux.conf'),
      claudeSettings: join(dataDir, 'claude-settings.json'),
      nodesDir: join(dataDir, 'nodes'),
      spoolDir: join(dataDir, 'spool'),
    },
  };
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Atomic write with explicit permissions (temp file + rename). */
export function writePrivateFile(file: string, content: string, mode = 0o600): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Events Claude Code knows (an unknown key would make it reject the settings file). */
export const CLAUDE_HOOK_EVENTS = HOOK_EVENTS.filter((e) => e !== 'PermissionRequest' && e !== 'Interrupt');

/**
 * Settings passed to every Claude node with `--settings`. Claude Code merges them with the
 * account's own settings, so the user's `settings.json` is never modified.
 */
export function claudeSettings(hookScript: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [
      {
        ...(event === 'PostToolUse' ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command: `${shellQuote(hookScript)} ${event}`, timeout: 5 }],
      },
    ];
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

export interface McpRunner {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Per-node MCP config passed with `--mcp-config`. Holds the node token, so it is 0600. */
export function nodeMcpConfig(runner: McpRunner, nodeEnv: Record<string, string>): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        flowdeck: { type: 'stdio', command: runner.command, args: runner.args, env: { ...runner.env, ...nodeEnv } },
      },
    },
    null,
    2,
  )}\n`;
}

/** Who a node is, for flowdeck-mcp (`--identity <file>`). Holds the token, so it is 0600. */
export function nodeIdentity(nodeId: string, token: string, socketPath: string): string {
  return `${JSON.stringify({ nodeId, token, socketPath }, null, 2)}\n`;
}

/** Copies the hook relay, MCP server and tmux config into the private data directory. */
export function installRuntimeFiles(paths: Paths, resourcesDir: string, mcpSource: string): void {
  for (const dir of [paths.dataDir, paths.binDir, paths.nodesDir, paths.spoolDir]) ensurePrivateDir(dir);
  writePrivateFile(paths.hookScript, readFileSync(join(resourcesDir, 'hook.sh'), 'utf8'), 0o700);
  writePrivateFile(paths.tmuxConf, readFileSync(join(resourcesDir, 'tmux.conf'), 'utf8'), 0o600);
  writePrivateFile(paths.claudeSettings, claudeSettings(paths.hookScript), 0o600);
  if (!existsSync(mcpSource)) throw new Error(`flowdeck-mcp bundle not found at ${mcpSource} (run pnpm build in packages/mcp)`);
  const tmp = `${paths.mcpScript}.tmp`;
  copyFileSync(mcpSource, tmp);
  chmodSync(tmp, 0o600);
  renameSync(tmp, paths.mcpScript);
}
