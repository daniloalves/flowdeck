import { join } from 'node:path';
import { CLAUDE_ACCOUNTS, accountEnv } from '../accounts/accounts';
import { settingsSkipPermissions } from '../accounts/permissions';
import { argsSkipPermissions } from '../bus/rules';
import { claudeStartArgs, planClaudeStart, transcriptExists } from '../restore/restore';
import { nodeMcpConfig } from '../runtime';
import type { AgentAdapter } from './types';

/** Claude Code flags FlowDeck owns; users cannot pass them as extra launch args. */
const RESERVED = [
  '--settings',
  '--mcp-config',
  '--strict-mcp-config',
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--print',
  '-p',
];

/** `--resume=x`, `-r<id>` and combined short flags (`-dc`) included. */
export function reservedFlag(arg: string, reserved: readonly string[] = RESERVED): string | null {
  if (arg.startsWith('--')) {
    const name = arg.split('=')[0]!;
    return reserved.includes(name) ? name : null;
  }
  if (arg.startsWith('-') && arg.length > 1) {
    const short = reserved.filter((f) => /^-[a-zA-Z]$/.test(f)).find((f) => arg.slice(1).includes(f[1]!));
    return short ?? null;
  }
  return null;
}

/**
 * Claude Code: hooks and the MCP server are passed per launch (`--settings`, `--mcp-config`) and
 * merged with the account's own settings, which are never modified. FlowDeck assigns the session
 * id up front (`--session-id`) so a reboot always resumes the right conversation.
 */
export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  bin: 'claude',
  accounts: CLAUDE_ACCOUNTS,
  status: 'hooks',
  mcp: true,

  reservedArgs: (args) => args.map((a) => reservedFlag(a)).find((r) => r !== null) ?? null,

  skipsApprovals: (args, { configDir, cwd }) =>
    argsSkipPermissions(args) || (configDir !== null && settingsSkipPermissions(configDir, cwd)),

  launch(ctx) {
    if (!ctx.account) throw new Error('a Claude node needs an account');
    const start = planClaudeStart(
      ctx.node,
      ctx.others,
      (sid) => transcriptExists(ctx.account!.configDir, sid),
      ctx.newId,
    );
    const mcpConfig = join(ctx.nodeDir, 'mcp.json');
    const runner = { ...ctx.mcpRunner, args: [...ctx.mcpRunner.args, '--identity', ctx.identityFile] };
    return {
      // `--mcp-config` is variadic: it comes first so a user argument can never extend it.
      command: [
        ctx.bin,
        '--mcp-config',
        mcpConfig,
        '--settings',
        ctx.claudeSettings,
        ...claudeStartArgs(start),
        ...ctx.node.launchArgs,
      ],
      env: accountEnv(ctx.account.configDir, ctx.home, CLAUDE_ACCOUNTS),
      files: [{ path: mcpConfig, content: nodeMcpConfig(runner, {}) }],
      sessionId: start.mode === 'new' ? start.sessionId : undefined,
      initialState: 'starting',
    };
  },
};
