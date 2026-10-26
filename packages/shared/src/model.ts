export type NodeKind = 'claude' | 'codex' | 'kiro' | 'shell';

/** Node kinds that run an AI agent CLI. */
export type AgentKind = Exclude<NodeKind, 'shell'>;
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'kiro'];

/** Agents whose accounts are config directories (Kiro has a single system login). */
export type AccountAgent = 'claude' | 'codex';

export const isAgentKind = (kind: NodeKind): kind is AgentKind => kind !== 'shell';

export type NodeState = 'starting' | 'working' | 'idle' | 'needs_input' | 'dead' | 'unknown';

export type EdgeDirection = 'one_way' | 'both';

export interface Account {
  id: string;
  agent: AccountAgent;
  label: string;
  configDir: string;
  color: string;
  /** Token cap used to compute the 5-hour percentage; null hides the percentage. */
  cap5h: number | null;
  cap7d: number | null;
}

export interface NodeLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeRecord extends NodeLayout {
  id: string;
  kind: NodeKind;
  title: string;
  cwd: string;
  accountId: string | null;
  tmuxSession: string;
  /** The agent's own conversation id (Claude/Codex/Kiro), used to resume after a reboot. */
  sessionId: string | null;
  launchArgs: string[];
  createdAt: number;
}

export interface NodeStatus {
  state: NodeState;
  detail: string | null;
  updatedAt: number;
}

/** What the renderer sees: a node with its status and derived flags. Never contains the token. */
export interface NodeView extends NodeRecord {
  status: NodeStatus;
  dangerous: boolean;
  queued: number;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  direction: EdgeDirection;
}

export type Delivery = 'pty' | 'inbox';

export interface Message {
  id: string;
  fromNode: string;
  fromTitle: string;
  toNode: string;
  toTitle: string;
  body: string;
  delivered: boolean;
  delivery: Delivery | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface UsageWindow {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AccountUsage {
  accountId: string;
  /** Active 5-hour block (ccusage semantics); null when no block is active. */
  block: (UsageWindow & { start: number; end: number }) | null;
  week: UsageWindow;
  computedAt: number;
}

export interface DiscoveredDir {
  agent: AccountAgent;
  configDir: string;
  suggestedId: string;
  loggedIn: boolean;
  registeredAs: string | null;
}

/** Drawings on the canvas: a group rectangle (with a title) or a free text. Never seen by agents. */
export type AnnotationKind = 'group' | 'text';

export interface Annotation extends NodeLayout {
  id: string;
  kind: AnnotationKind;
  /** Group title or text content. */
  text: string;
  color: string;
  fontSize: number;
  createdAt: number;
}

/** Scrollback position of a node's terminal (tmux copy mode). */
export interface ScrollState {
  /** Scrolled back (tmux copy mode). */
  inMode: boolean;
  /** Lines above the bottom (0 = at the bottom). */
  position: number;
  /** Lines of scrollback. */
  history: number;
  rows: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Environment {
  home: string;
  tmuxAvailable: boolean;
  tmuxVersion: string | null;
  /** Absolute path of each agent CLI, or null when it is not installed. */
  agents: Record<AgentKind, string | null>;
  autostart: boolean;
}

export interface AppSnapshot {
  accounts: Account[];
  nodes: NodeView[];
  edges: Edge[];
  annotations: Annotation[];
  usage: AccountUsage[];
  viewport: Viewport | null;
  env: Environment;
}
