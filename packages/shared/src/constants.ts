/** Name of the dedicated tmux socket (`tmux -L flowdeck`). */
export const DEFAULT_TMUX_SOCKET = 'flowdeck';

/** Prefix of every tmux session created by FlowDeck. */
export const TMUX_SESSION_PREFIX = 'fd-';

/** Environment variables FlowDeck injects into each node. */
export const ENV = {
  nodeId: 'FLOWDECK_NODE_ID',
  /** Path of the node's 0600 identity file (id, token, socket). The token itself is never in env/argv. */
  identity: 'FLOWDECK_IDENTITY',
  sock: 'FLOWDECK_SOCK',
  spool: 'FLOWDECK_SPOOL',
} as const;

/** HTTP headers used on the event socket. */
export const HEADER = {
  node: 'x-flowdeck-node',
  token: 'x-flowdeck-token',
} as const;

/** Variables stripped from the tmux server environment (by name only; values are never read). */
export const STRIPPED_ENV_VARS = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'TMUX',
  'TMUX_PANE',
  ENV.nodeId,
  ENV.identity,
  'FLOWDECK_NODE_TOKEN', // sessions started by FlowDeck 0.1.0
  ENV.sock,
  ENV.spool,
] as const;

export const DANGEROUS_FLAG = '--dangerously-skip-permissions';

/** The flag each agent uses to run without approval prompts (offered as a checkbox in the UI). */
export const SKIP_APPROVALS_FLAG = {
  claude: DANGEROUS_FLAG,
  codex: '--dangerously-bypass-approvals-and-sandbox',
  kiro: '--trust-all-tools',
} as const;

export const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro', shell: 'Shell' } as const;

export const LIMITS = {
  /** Max characters of one agent-to-agent message. */
  messageChars: 4000,
  /** Max messages per edge direction within `rateWindowMs`. */
  messagesPerWindow: 10,
  rateWindowMs: 60_000,
  /** Max undelivered messages waiting for one node. */
  queuePerTarget: 20,
  /** Max request body accepted by the event socket. */
  bodyBytes: 256 * 1024,
  titleChars: 80,
  launchArgs: 16,
  launchArgChars: 200,
  /** Max characters copied to or pasted from the clipboard at once. */
  clipboardChars: 1024 * 1024,
  /** Max groups + texts drawn on the canvas, and characters of one text. */
  annotations: 1000,
  annotationChars: 2000,
} as const;

export const USAGE = {
  blockMs: 5 * 60 * 60 * 1000,
  weekMs: 7 * 24 * 60 * 60 * 1000,
  refreshMs: 30_000,
} as const;
