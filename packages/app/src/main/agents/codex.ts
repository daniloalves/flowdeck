import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { CODEX_ACCOUNTS, accountEnv } from '../accounts/accounts';
import { sharesWorkspace } from '../restore/restore';
import { normalizeArgs, optionValue, optionValues } from './args';
import { shellQuote, type AgentAdapter } from './types';

/** Codex events FlowDeck listens to (Codex's names are already the canonical ones). */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
] as const;

/** Codex short options that take a value (`-cKEY=V`, `-a never`...). */
const SHORT_WITH_VALUE = new Set(['-c', '-a', '-s', '-p', '-m', '-i', '-C']);
const CONFIG = ['-c', '--config'];

/** TOML basic string (JSON string escapes are valid TOML escapes). */
const toml = (s: string): string => JSON.stringify(s);

/** `-c` keys FlowDeck owns: its hooks, its MCP server (or the whole table) and the hooks switch. */
const RESERVED_CONFIG =
  /^(hooks(\..*)?|mcp_servers|mcp_servers\.["']?flowdeck["']?(\..*)?|features|features\.(hooks|codex_hooks))$/;
const RESERVED_FLAGS = ['--dangerously-bypass-hook-trust', '--remote', '--remote-auth-token-env'];
const SKIP_FLAGS = ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--approve-for-me'];

const configKey = (value: string): string => value.split('=')[0]!.trim().replace(/^["']|["']$/g, '');
const configValue = (value: string): string =>
  value
    .slice(value.indexOf('=') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');

type Settings = { approval_policy?: unknown; sandbox_mode?: unknown; profile?: unknown; profiles?: Record<string, Settings> };

const neverAsks = (s: Settings | undefined): boolean =>
  s?.approval_policy === 'never' || s?.sandbox_mode === 'danger-full-access';

/** Parsed Codex config, `{}` if absent, or 'invalid' (treated as dangerous: we cannot tell). */
function readConfig(file: string): Settings | 'invalid' {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return parseToml(text) as Settings;
  } catch {
    return 'invalid';
  }
}

/**
 * OpenAI Codex CLI. Hooks and the MCP server are injected with `-c` overrides, so
 * `$CODEX_HOME/config.toml` is never modified. Codex asks once per Codex home to trust the hooks
 * (they are identical for every node); FlowDeck never bypasses that trust.
 */
export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  bin: 'codex',
  accounts: CODEX_ACCOUNTS,
  status: 'hooks',
  mcp: true,

  reservedArgs(raw) {
    if (raw[0] !== undefined && !raw[0].startsWith('-')) return `subcommand or prompt "${raw[0]}"`;
    const args = normalizeArgs(raw, SHORT_WITH_VALUE);
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (RESERVED_FLAGS.includes(a)) return a;
      const next = args[i + 1] ?? '';
      if (CONFIG.includes(a) && RESERVED_CONFIG.test(configKey(next))) return `-c ${configKey(next)}`;
      if ((a === '--disable' || a === '--enable') && /^(codex_)?hooks$/.test(next)) return `${a} hooks`;
    }
    return null;
  },

  skipsApprovals(raw, { configDir, cwd }) {
    const args = normalizeArgs(raw, SHORT_WITH_VALUE);
    if (args.some((a) => SKIP_FLAGS.includes(a))) return true;
    if (optionValue(args, ['-a', '--ask-for-approval']) === 'never') return true;
    if (optionValue(args, ['-s', '--sandbox']) === 'danger-full-access') return true;
    const overrides = optionValues(args, CONFIG);
    const override = (key: string) => overrides.filter((o) => configKey(o) === key).map(configValue).pop();
    if (override('approval_policy') === 'never' || override('sandbox_mode') === 'danger-full-access') return true;

    // Effective configuration: user config, project config, then the selected profile.
    const layers = [configDir ? readConfig(join(configDir, 'config.toml')) : {}, readConfig(join(cwd, '.codex', 'config.toml'))];
    if (layers.includes('invalid')) return true;
    const configs = layers as Settings[];
    if (configs.some(neverAsks)) return true;
    const profile =
      optionValue(args, ['-p', '--profile']) ??
      override('profile') ??
      (configs.map((c) => c.profile).filter((p): p is string => typeof p === 'string').pop() || undefined);
    if (profile) {
      if (configs.some((c) => neverAsks(c.profiles?.[profile]))) return true;
      if (configDir && /^[\w.-]+$/.test(profile)) {
        const layered = readConfig(join(configDir, `${profile}.config.toml`));
        if (layered === 'invalid' || neverAsks(layered)) return true;
      }
    }
    return false;
  },

  // Clap reads everything after `--` as the prompt (`codex -- completion` starts a chat, verified).
  taskError: () => null,

  launch(ctx) {
    if (!ctx.account) throw new Error('a Codex node needs an account');
    const start = ctx.node.sessionId
      ? ['resume', ctx.node.sessionId]
      : !ctx.firstLaunch && !sharesWorkspace(ctx.node, ctx.others)
        ? ['resume', '--last']
        : [];
    const hooks = CODEX_HOOK_EVENTS.flatMap((event) => [
      '-c',
      // Codex caps some hook timeouts at 3 s; hook.sh itself gives up after 1 s.
      `hooks.${event}=[{hooks=[{type="command",command=${toml(`${shellQuote(ctx.hookScript)} ${event}`)},timeout=3}]}]`,
    ]);
    const runnerArgs = [...ctx.mcpRunner.args, '--identity', ctx.identityFile];
    const env = Object.entries(ctx.mcpRunner.env)
      .map(([k, v]) => `${k}=${toml(v)}`)
      .join(',');
    const mcp = [
      '-c',
      `mcp_servers.flowdeck.command=${toml(ctx.mcpRunner.command)}`,
      '-c',
      `mcp_servers.flowdeck.args=[${runnerArgs.map(toml).join(',')}]`,
      '-c',
      `mcp_servers.flowdeck.env={${env}}`,
    ];
    // A first task goes after `--`, so a leading dash or an option value cannot take it.
    const task = ctx.task && ctx.firstLaunch && start.length === 0 ? ['--', ctx.task] : [];
    return {
      command: [ctx.bin, ...start, ...hooks, ...mcp, ...ctx.node.launchArgs, ...task],
      env: accountEnv(ctx.account.configDir, ctx.home, CODEX_ACCOUNTS),
      files: [],
      // Not deliverable until Codex shows it is past any start-up dialog (its first hook event).
      initialState: 'starting',
      initialDetail:
        task.length > 0
          ? 'Starting with your task. If Codex asks, trust FlowDeck’s hooks once.'
          : 'Ready for your first prompt. If Codex asks, trust FlowDeck’s hooks once.',
    };
  },
};
