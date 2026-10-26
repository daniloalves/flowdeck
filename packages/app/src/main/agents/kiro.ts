import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharesWorkspace } from '../restore/restore';
import { normalizeArgs, optionValue } from './args';
import { reservedFlag } from './claude';
import type { AgentAdapter } from './types';

const RESERVED = [
  '--resume',
  '-r',
  '--resume-id',
  '--resume-picker',
  '--sessions',
  '--no-interactive',
  '--list-sessions',
  '-l',
  '--list-models',
];

const SHORT_WITH_VALUE = new Set(['-f']);
const RISKY_TOOL = /^(\*|@?builtin\/?\*?|execute_bash|execute_cmd|shell|use_aws|aws|fs_write|write)$/i;
/** Names of Kiro's built-in default agent (no file on disk; asks before running tools). */
const BUILT_IN_AGENTS = new Set(['kiro_default', 'q_cli_default', 'default']);

const riskyList = (value: string | undefined): boolean =>
  (value ?? '').split(',').some((t) => RISKY_TOOL.test(t.trim().replace(/^@builtin\//, '')) || t.trim() === '*');

function readJson(file: string): Record<string, unknown> | null | 'invalid' {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Does this agent file let tools run without asking? Unknown formats count as yes. */
function agentSkipsApprovals(agent: Record<string, unknown>): boolean {
  if ('permissions' in agent || 'toolsSettings' in agent) return true; // newer/finer formats: cannot verify
  const allowed = agent.allowedTools;
  if (allowed === undefined) return false;
  if (!Array.isArray(allowed)) return true;
  return allowed.some((t) => typeof t !== 'string' || riskyList(t));
}

/**
 * Kiro CLI. Kiro only reads hooks and MCP servers from agent files under `~/.kiro` or the
 * project, so FlowDeck does not inject anything (design decision D1): the state comes from
 * terminal activity, and Kiro nodes can receive messages but not send them.
 */
export const kiroAdapter: AgentAdapter = {
  kind: 'kiro',
  bin: 'kiro-cli',
  accounts: null,
  status: 'activity',
  mcp: false,

  reservedArgs(raw) {
    if (raw[0] !== undefined && !raw[0].startsWith('-')) return `subcommand or prompt "${raw[0]}"`;
    for (const arg of raw) {
      const reserved = reservedFlag(arg, RESERVED);
      if (reserved) return reserved;
    }
    return null;
  },

  skipsApprovals(raw, { cwd, home }) {
    const args = normalizeArgs(raw, SHORT_WITH_VALUE);
    if (args.includes('-a') || args.includes('--trust-all-tools')) return true;
    if (args.includes('--trust-tools') && riskyList(optionValue(args, ['--trust-tools']))) return true;

    // The agent in effect: --agent, else the configured default, else the built-in one.
    const settings = readJson(join(home, '.kiro', 'settings', 'cli.json'));
    if (settings === 'invalid') return true;
    const nested = settings?.chat as Record<string, unknown> | undefined;
    const fallback = settings?.['chat.defaultAgent'] ?? nested?.defaultAgent;
    const name = optionValue(args, ['--agent']) ?? (typeof fallback === 'string' ? fallback : undefined);
    if (!name || BUILT_IN_AGENTS.has(name)) return false;
    if (!/^[\w.-]+$/.test(name)) return true;
    for (const dir of [join(cwd, '.kiro', 'agents'), join(home, '.kiro', 'agents')]) {
      const agent = readJson(join(dir, `${name}.json`));
      if (agent === 'invalid') return true;
      if (agent) return agentSkipsApprovals(agent);
    }
    return true; // an agent FlowDeck cannot find or read: assume the worst
  },

  launch(ctx) {
    // `--resume` takes the most recent conversation of the directory: only when unambiguous.
    const resume = !ctx.firstLaunch && !sharesWorkspace(ctx.node, ctx.others) ? ['--resume'] : [];
    return {
      command: [ctx.bin, 'chat', ...resume, ...ctx.node.launchArgs],
      env: {},
      files: [],
      // Becomes idle after its start-up output settles (activity status).
      initialState: 'starting',
    };
  },
};
