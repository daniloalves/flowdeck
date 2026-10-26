import type { Account, AgentKind, NodeRecord, NodeState } from '@flowdeck/shared';
import type { AccountSpec } from '../accounts/accounts';
import type { McpRunner } from '../runtime';

/** Everything an adapter needs to build a launch. Pure data: adapters do no I/O except reads. */
export interface LaunchContext {
  node: NodeRecord;
  account: Account | null;
  /** All nodes, to decide whether "continue the latest conversation of this directory" is safe. */
  others: NodeRecord[];
  /** First launch of a new node (as opposed to a restore or a resume after exit). */
  firstLaunch: boolean;
  bin: string;
  home: string;
  hookScript: string;
  claudeSettings: string;
  mcpRunner: McpRunner;
  /** Per-node directory (0700) for generated files. */
  nodeDir: string;
  /** Per-node identity file for flowdeck-mcp (written by Core before launch). */
  identityFile: string;
  newId: () => string;
}

export interface LaunchPlan {
  /** argv executed directly by tmux (no shell). */
  command: string[];
  /** Extra environment for the session (account selection). FlowDeck identity is added by Core. */
  env: Record<string, string>;
  /** Private files (0600) to write before launching. */
  files: { path: string; content: string }[];
  /** Session id to persist before launch (Claude assigns it up front), or undefined to keep. */
  sessionId?: string | null;
  initialState: NodeState;
  /** Shown with the initial state (e.g. what the node is waiting for). */
  initialDetail?: string;
}

export interface AgentAdapter {
  kind: AgentKind;
  /** Executable looked up in PATH; `FLOWDECK_<KIND>_BIN` overrides it (tests). */
  bin: string;
  /** null: the agent has a single system login (Kiro). */
  accounts: AccountSpec | null;
  /** Where node state comes from: agent hooks, or terminal activity when hooks are unavailable. */
  status: 'hooks' | 'activity';
  /** The agent gets the flowdeck MCP tools and can send messages to peers. */
  mcp: boolean;
  /** The first FlowDeck-managed option the user arguments would set, or null. */
  reservedArgs(args: readonly string[]): string | null;
  /** Does the node run without approval prompts (flags, or settings files it would read)? */
  skipsApprovals(args: readonly string[], ctx: { configDir: string | null; cwd: string; home: string }): boolean;
  launch(ctx: LaunchContext): LaunchPlan;
}

/** Shell-quotes a path for a hook command line. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
