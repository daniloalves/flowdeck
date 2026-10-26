import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AGENT_KINDS,
  AGENT_LABEL,
  ENV,
  LIMITS,
  isAgentKind,
  type AgentKind,
  type NodeRecord,
  TMUX_SESSION_PREFIX,
  USAGE,
  accountInputSchema,
  annotationPatchSchema,
  newAnnotationSchema,
  newEdgeSchema,
  newNodeSchema,
  nodePatchSchema,
  sendToSchema,
  type Account,
  type AccountUsage,
  type Annotation,
  type AppSnapshot,
  type DiscoveredDir,
  type Edge,
  type EventApi,
  type EventChannel,
  type HookEvent,
  type HookPayload,
  type InboxMessage,
  type Message,
  type NodeState,
  type NodeStatus,
  type NodeView,
  type PeerInfo,
  type SendResult,
  type Viewport,
} from '@flowdeck/shared';
import { discoverConfigDirs } from './accounts/accounts';
import { AGENTS } from './agents';
import { edgeAllows, escalationError, findRoute, validateNewEdge } from './bus/rules';
import { formatDelivery, sanitizeForTerminal } from './bus/sanitize';
import type { NodeWithToken, Repo } from './db/repo';
import { EventServer, HttpError } from './events/server';
import { isHookEvent, transition, validSessionId } from './events/state';
import { nodeIdentity, writePrivateFile, type McpRunner, type Paths } from './runtime';
import type { Tmux } from './tmux/tmux';
import { UsageReader } from './usage/reader';
import { computeUsage } from './usage/windows';

export interface Notifier {
  notify(title: string, body: string, nodeId: string): void;
}

export interface CoreOptions {
  repo: Repo;
  tmux: Tmux;
  paths: Paths;
  home: string;
  /** Absolute path of each agent CLI; missing or null when it is not installed. */
  agentBins: Partial<Record<AgentKind, string | null>>;
  shellBin: string;
  mcpRunner: McpRunner;
  emit: <C extends EventChannel>(channel: C, payload: EventApi[C]) => void;
  notifier: Notifier;
  isAppFocused: () => boolean;
  /** Pane liveness poll interval; 0 disables the timer (tests call `checkPanes`). */
  paneIntervalMs?: number;
  /** Usage refresh interval; 0 disables the timer. */
  usageIntervalMs?: number;
}

const DEFAULT_SIZE = { w: 720, h: 440 };
const NOTIFY_INTERVAL_MS = 3000;
/** Activity status (agents without hooks): output within this window means "working"... */
const ACTIVE_WITHIN_MS = 3000;
/** ...and this much silence means "idle" again (hysteresis avoids flicker). */
const QUIET_AFTER_MS = 5000;
/** How often skip-approval settings are re-read for running nodes. */
const DANGER_REFRESH_MS = 10_000;

export class Core {
  readonly events: EventServer;
  private paneTimer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private usageReaders = new Map<string, UsageReader>();
  private usage = new Map<string, AccountUsage>();
  private focusedNode: string | null = null;
  private delivering = new Set<string>();
  private tmuxVersion: string | null = null;
  private launching = new Set<string>();
  private checkingPanes = false;
  /** Skip-approval verdict per node: flags + settings files, refreshed on every launch. */
  private dangerCache = new Map<string, boolean>();
  private lastNotify = new Map<string, number>();
  private duplicateQueue: Promise<unknown> = Promise.resolve();
  private dangerCheckedAt = 0;

  constructor(readonly opts: CoreOptions) {
    this.events = new EventServer(opts.paths.socketPath, {
      tokenOf: (id) => this.opts.repo.getNode(id)?.token ?? null,
      onHook: (id, event, payload) => this.onHook(id, event, payload),
      listPeers: (id) => this.listPeers(id),
      sendTo: (id, body) => this.sendTo(id, body),
      readInbox: (id) => this.readInbox(id),
    });
  }

  private get repo(): Repo {
    return this.opts.repo;
  }

  /* ------------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.tmuxVersion = await this.opts.tmux.version();
    // A server started by an older FlowDeck keeps running across upgrades: give it today's settings.
    if (this.tmuxVersion) await this.opts.tmux.reloadConfig();
    await this.events.start();
    await this.restoreAll();
    const paneMs = this.opts.paneIntervalMs ?? 2000;
    if (paneMs > 0) this.paneTimer = setInterval(() => void this.checkPanes(), paneMs);
    const usageMs = this.opts.usageIntervalMs ?? USAGE.refreshMs;
    void this.refreshUsage();
    if (usageMs > 0) this.usageTimer = setInterval(() => void this.refreshUsage(), usageMs);
  }

  /** Stops FlowDeck's own services. tmux sessions keep running by design. */
  async stop(): Promise<void> {
    if (this.paneTimer) clearInterval(this.paneTimer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.paneTimer = this.usageTimer = null;
    await this.events.stop();
  }

  snapshot(): AppSnapshot {
    return {
      accounts: this.repo.listAccounts(),
      nodes: this.repo.listNodes().map((n) => this.view(n)),
      edges: this.repo.listEdges(),
      annotations: this.repo.listAnnotations(),
      usage: [...this.usage.values()],
      viewport: this.repo.getViewport(),
      env: {
        home: this.opts.home,
        tmuxAvailable: this.tmuxVersion !== null,
        tmuxVersion: this.tmuxVersion,
        agents: Object.fromEntries(AGENT_KINDS.map((k) => [k, this.opts.agentBins[k] ?? null])) as Record<
          AgentKind,
          string | null
        >,
        autostart: false,
      },
    };
  }

  view(n: NodeWithToken): NodeView {
    // The token never leaves the main process.
    const { token: _token, ...record } = n;
    return {
      ...record,
      status: this.repo.getStatus(n.id),
      dangerous: this.isDangerous(n),
      queued: this.repo.countPendingFor(n.id),
    };
  }

  private emitNode(id: string): NodeView | null {
    const node = this.repo.getNode(id);
    if (!node) return null;
    const v = this.view(node);
    this.opts.emit('node:changed', v);
    return v;
  }

  private setState(id: string, state: NodeState, detail: string | null = null): void {
    const status: NodeStatus = { state, detail, updatedAt: Date.now() };
    this.repo.setStatus(id, status);
    this.emitNode(id);
  }

  private mustNode(id: string): NodeWithToken {
    const node = this.repo.getNode(id);
    if (!node) throw new Error('node not found');
    return node;
  }

  /** Runs without approval prompts: by flag, by approval mode, or by a settings file. */
  readonly isDangerous = (node: NodeRecord): boolean => {
    if (!isAgentKind(node.kind)) return false;
    return this.dangerCache.get(node.id) ?? this.computeDanger(node);
  };

  private computeDanger(node: NodeRecord): boolean {
    if (!isAgentKind(node.kind)) return false;
    const account = node.accountId ? this.repo.getAccount(node.accountId) : null;
    const verdict = AGENTS[node.kind].skipsApprovals(node.launchArgs, {
      configDir: account?.configDir ?? null,
      cwd: node.cwd,
      home: this.opts.home,
    });
    this.dangerCache.set(node.id, verdict);
    return verdict;
  }

  /* ------------------------------------------------------------------ nodes */

  async createNode(raw: unknown): Promise<NodeView> {
    const input = newNodeSchema.parse(raw);
    const cwd = resolve(input.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`directory not found: ${cwd}`);
    if (this.tmuxVersion === null) throw new Error('tmux is not installed');

    let accountId: string | null = null;
    if (isAgentKind(input.kind)) {
      const adapter = AGENTS[input.kind];
      const label = AGENT_LABEL[input.kind];
      if (!this.opts.agentBins[input.kind]) throw new Error(`the ${label} CLI (${adapter.bin}) was not found in PATH`);
      if (adapter.accounts) {
        if (!input.accountId) throw new Error(`choose an account for a ${label} node`);
        const account = this.repo.getAccount(input.accountId);
        if (!account) throw new Error(`unknown account: ${input.accountId}`);
        if (account.agent !== adapter.accounts.agent) throw new Error(`"${account.label}" is not a ${label} account`);
        accountId = account.id;
      }
      const reserved = adapter.reservedArgs(input.launchArgs);
      if (reserved) throw new Error(`${reserved} is managed by FlowDeck`);
    } else if (input.launchArgs.length > 0) {
      throw new Error('shell nodes do not take launch arguments');
    }

    const id = randomUUID();
    const count = this.repo.listNodes().length;
    const layout = input.layout ?? { x: 80 + (count % 4) * 760, y: 80 + Math.floor(count / 4) * 480, ...DEFAULT_SIZE };
    const node: NodeWithToken = {
      id,
      kind: input.kind,
      title: input.title,
      cwd,
      accountId,
      tmuxSession: `${TMUX_SESSION_PREFIX}${id.replace(/-/g, '').slice(0, 12)}`,
      // Claude takes its session id from FlowDeck; the others reveal theirs through hooks.
      sessionId: input.kind === 'claude' ? randomUUID() : null,
      launchArgs: input.launchArgs,
      token: randomBytes(32).toString('hex'),
      ...layout,
      createdAt: Date.now(),
    };
    this.repo.insertNode(node, { state: 'starting', detail: null, updatedAt: Date.now() });
    try {
      await this.launch(node, true);
    } catch (err) {
      this.repo.deleteNode(id);
      throw err;
    }
    return this.view(this.mustNode(id));
  }

  updateNode(id: string, raw: unknown): NodeView {
    const patch = nodePatchSchema.parse(raw);
    this.mustNode(id);
    if (patch.title !== undefined) this.repo.updateNodeTitle(id, patch.title);
    if (patch.layout) this.repo.updateNodeLayout(id, patch.layout);
    return this.view(this.mustNode(id));
  }

  async deleteNode(id: string): Promise<void> {
    const node = this.mustNode(id);
    const edges = this.repo.edgesOf(id);
    await this.opts.tmux.killSession(node.tmuxSession);
    this.repo.discardPendingFor(id);
    this.repo.deleteNode(id);
    rmSync(join(this.opts.paths.nodesDir, id), { recursive: true, force: true });
    this.removeSpool(id);
    for (const e of edges) this.opts.emit('edge:removed', { id: e.id });
    this.opts.emit('node:removed', { id });
  }

  /**
   * A new node with the same type, directory, account and arguments, placed to the right.
   * Serialised, so quick repeated duplicates never pick the same title.
   */
  duplicateNode(id: string): Promise<NodeView> {
    const run = () => this.duplicateNow(id);
    const next = this.duplicateQueue.then(run, run);
    this.duplicateQueue = next.catch(() => undefined);
    return next;
  }

  private async duplicateNow(id: string): Promise<NodeView> {
    const source = this.mustNode(id);
    const titles = new Set(this.repo.listNodes().map((n) => n.title));
    const base = source.title.replace(/ #\d+$/, '').slice(0, LIMITS.titleChars - 6);
    let n = 2;
    while (titles.has(`${base} #${n}`)) n++;
    return this.createNode({
      kind: source.kind,
      title: `${base} #${n}`,
      cwd: source.cwd,
      accountId: source.accountId,
      launchArgs: source.launchArgs,
      layout: { x: source.x + source.w + 40, y: source.y, w: source.w, h: source.h },
    });
  }

  /** Recreates the process of a node (the "resume" button on dead nodes). */
  async restartNode(id: string): Promise<NodeView> {
    const node = this.mustNode(id);
    await this.opts.tmux.killSession(node.tmuxSession);
    await this.launch(node);
    return this.view(this.mustNode(id));
  }

  /** Creates the tmux session for a node. Never goes through a shell. */
  private async launch(node: NodeWithToken, firstLaunch = false): Promise<void> {
    this.launching.add(node.id);
    try {
      await this.launchSession(node, firstLaunch);
    } finally {
      this.launching.delete(node.id);
    }
  }

  private async launchSession(node: NodeWithToken, firstLaunch: boolean): Promise<void> {
    const { paths } = this.opts;
    let command: string[];
    let env: Record<string, string> = {};
    let initialState: NodeState = 'idle';
    let initialDetail: string | null = null;

    if (isAgentKind(node.kind)) {
      const adapter = AGENTS[node.kind];
      const label = AGENT_LABEL[node.kind];
      const bin = this.opts.agentBins[node.kind];
      if (!bin) throw new Error(`the ${label} CLI (${adapter.bin}) was not found in PATH`);
      const account = node.accountId ? this.repo.getAccount(node.accountId) : null;
      if (adapter.accounts && !account) throw new Error('the account of this node no longer exists');
      const nodeDir = join(paths.nodesDir, node.id);
      const identityFile = join(nodeDir, 'identity.json');
      // The token lives only in this 0600 file: tmux keeps its first command line (with every -e
      // value) for the server's lifetime, readable by any user through ps. A new token per launch
      // also retires any token an older version exposed that way.
      if (adapter.mcp || adapter.status === 'hooks') {
        node.token = randomBytes(32).toString('hex');
        this.repo.setToken(node.id, node.token);
        writePrivateFile(identityFile, nodeIdentity(node.id, node.token, paths.socketPath));
      }
      const plan = adapter.launch({
        node,
        account,
        others: this.repo.listNodes(),
        firstLaunch,
        bin,
        home: this.opts.home,
        hookScript: paths.hookScript,
        claudeSettings: paths.claudeSettings,
        mcpRunner: this.opts.mcpRunner,
        nodeDir,
        identityFile,
        newId: () => randomUUID(),
      });
      for (const f of plan.files) writePrivateFile(f.path, f.content);
      if (plan.sessionId !== undefined && plan.sessionId !== node.sessionId) this.repo.setSessionId(node.id, plan.sessionId);
      // Only agents with hooks get an identity in their environment (least privilege).
      const identity: Record<string, string> =
        adapter.status === 'hooks'
          ? {
              [ENV.nodeId]: node.id,
              [ENV.identity]: identityFile,
              [ENV.sock]: paths.socketPath,
              [ENV.spool]: paths.spoolDir,
            }
          : {};
      env = { ...plan.env, ...identity };
      command = plan.command;
      initialState = plan.initialState;
      initialDetail = plan.initialDetail ?? null;
      this.computeDanger(node);
    } else {
      command = [this.opts.shellBin, '-l'];
    }

    await this.opts.tmux.newSession({
      name: node.tmuxSession,
      cwd: node.cwd,
      env,
      command,
      cols: 100,
      rows: 30,
    });
    this.removeSpool(node.id);
    this.setState(node.id, initialState, initialDetail);
  }

  /* ------------------------------------------------------------------ restore & liveness */

  /** On start: attach to surviving sessions, recreate the ones lost (reboot). */
  async restoreAll(): Promise<void> {
    if (this.tmuxVersion === null) return;
    for (const node of this.repo.listNodes()) {
      try {
        if (await this.opts.tmux.hasSession(node.tmuxSession)) {
          this.applySpool(node);
        } else {
          await this.launch(node);
        }
      } catch (err) {
        this.setState(node.id, 'dead', err instanceof Error ? err.message : String(err));
      }
    }
    await this.checkPanes();
    // Messages queued while FlowDeck was closed go to nodes that are already idle.
    for (const node of this.repo.listNodes()) void this.deliverPending(node.id);
  }

  /** Events that happened while FlowDeck was closed (written by hook.sh). */
  private applySpool(node: NodeWithToken): void {
    const file = join(this.opts.paths.spoolDir, node.id);
    let event: string;
    try {
      event = readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    this.removeSpool(node.id);
    if (!isHookEvent(event)) return;
    const t = transition(this.repo.getStatus(node.id).state, event, {}, node.title);
    if (t.state) this.setState(node.id, t.state, event === 'Notification' ? 'needs attention (while FlowDeck was closed)' : null);
  }

  private removeSpool(id: string): void {
    try {
      unlinkSync(join(this.opts.paths.spoolDir, id));
    } catch {
      /* none */
    }
  }

  /**
   * Marks nodes whose process exited (dead pane) or whose session vanished. The pane list is a
   * snapshot taken asynchronously, so nodes being launched, or whose state changed after the
   * snapshot started, are skipped; a missing session is confirmed with has-session first.
   */
  async checkPanes(): Promise<void> {
    if (this.tmuxVersion === null || this.checkingPanes) return;
    this.checkingPanes = true;
    try {
      const startedAt = Date.now();
      const panes = await this.opts.tmux.listPanes();
      if (panes === null) return; // tmux error: never guess
      if (startedAt - this.dangerCheckedAt >= DANGER_REFRESH_MS) this.refreshDanger(startedAt);
      const bySession = new Map(panes.map((p) => [p.session, p]));
      for (const node of this.repo.listNodes()) {
        if (this.launching.has(node.id)) continue;
        const status = this.repo.getStatus(node.id);
        if (status.state === 'dead' || status.updatedAt >= startedAt) continue;
        const pane = bySession.get(node.tmuxSession);
        if (pane && !pane.dead) {
          this.applyActivity(node, status.state, pane.activityAt, startedAt);
          continue;
        }
        if (!pane && (await this.opts.tmux.hasSession(node.tmuxSession))) continue;
        if (this.launching.has(node.id)) continue;
        this.setState(node.id, 'dead', pane ? 'process exited' : 'session not found');
      }
    } finally {
      this.checkingPanes = false;
    }
  }

  /** Settings files can change while a node runs (agents reload them): re-check skip-approval. */
  private refreshDanger(now: number): void {
    this.dangerCheckedAt = now;
    for (const node of this.repo.listNodes()) {
      const before = this.dangerCache.get(node.id);
      if (this.computeDanger(node) !== before && before !== undefined) this.emitNode(node.id);
    }
  }

  /** Status for agents without hooks: output means working, silence means idle. */
  private applyActivity(node: NodeRecord, state: NodeState, activityAt: number, now: number): void {
    if (!isAgentKind(node.kind) || AGENTS[node.kind].status !== 'activity' || activityAt <= 0) return;
    const quietFor = now - activityAt;
    if (quietFor <= ACTIVE_WITHIN_MS && (state === 'idle' || state === 'starting' || state === 'unknown')) {
      this.setState(node.id, 'working');
    } else if (quietFor >= QUIET_AFTER_MS && state !== 'idle') {
      this.setState(node.id, 'idle');
      void this.deliverPending(node.id);
    }
  }

  /* ------------------------------------------------------------------ hooks */

  onHook(nodeId: string, event: HookEvent, payload: HookPayload): void {
    const node = this.repo.getNode(nodeId);
    if (!node) return;
    const current = this.repo.getStatus(nodeId).state;
    const t = transition(current, event, payload, node.title);
    // SessionStart always carries the current id (it changes on /clear); other events only fill
    // it in when unknown (Codex reveals its id with the first prompt).
    const sessionId = t.sessionId ?? (node.sessionId ? null : validSessionId(payload.session_id));
    if (sessionId && sessionId !== node.sessionId) this.repo.setSessionId(nodeId, sessionId);
    if (t.state && (t.state !== current || t.detail)) this.setState(nodeId, t.state, t.detail);
    else if (sessionId) this.emitNode(nodeId);
    if (t.notify && !this.opts.isAppFocused() && this.mayNotify(nodeId)) {
      this.opts.notifier.notify(t.notify.title, t.notify.body, nodeId);
    }
    if (t.deliver) void this.deliverPending(nodeId);
  }

  /** At most one desktop notification per node every few seconds (hooks can be spammed). */
  private mayNotify(nodeId: string): boolean {
    const now = Date.now();
    if (now - (this.lastNotify.get(nodeId) ?? 0) < NOTIFY_INTERVAL_MS) return false;
    this.lastNotify.set(nodeId, now);
    return true;
  }

  /* ------------------------------------------------------------------ edges */

  createEdge(raw: unknown): Edge {
    const input = newEdgeSchema.parse(raw);
    const source = this.mustNode(input.source);
    const target = this.mustNode(input.target);
    const error = validateNewEdge(source, target, input.direction, this.repo.listEdges(), this.isDangerous);
    if (error) throw new Error(error);
    const edge: Edge = { id: randomUUID(), source: source.id, target: target.id, direction: input.direction };
    this.repo.insertEdge(edge);
    return edge;
  }

  deleteEdge(id: string): void {
    this.repo.deleteEdge(id);
  }

  /* ------------------------------------------------------------------ canvas drawings */

  createAnnotation(raw: unknown): Annotation {
    const input = newAnnotationSchema.parse(raw);
    if (this.repo.countAnnotations() >= LIMITS.annotations) {
      throw new Error(`the canvas already has ${LIMITS.annotations} groups and texts`);
    }
    const annotation: Annotation = { id: randomUUID(), ...input, createdAt: Date.now() };
    this.repo.insertAnnotation(annotation);
    return annotation;
  }

  updateAnnotation(id: string, raw: unknown): Annotation {
    const patch = annotationPatchSchema.parse(raw);
    if (!this.repo.getAnnotation(id)) throw new Error('group or text not found');
    this.repo.updateAnnotation(id, patch);
    return this.repo.getAnnotation(id)!;
  }

  deleteAnnotation(id: string): void {
    this.repo.deleteAnnotation(id);
  }

  /* ------------------------------------------------------------------ agent API */

  listPeers(nodeId: string): PeerInfo[] {
    const self = this.mustNode(nodeId);
    const peers: PeerInfo[] = [];
    for (const e of this.repo.edgesOf(nodeId)) {
      const peerId = e.source === nodeId ? e.target : e.source;
      const peer = this.repo.getNode(peerId);
      if (!peer) continue;
      const account = peer.accountId ? this.repo.getAccount(peer.accountId) : null;
      peers.push({
        id: peer.id,
        title: peer.title,
        account: account?.label ?? null,
        state: this.repo.getStatus(peer.id).state,
        canSend: edgeAllows(e, nodeId, peer.id) && escalationError(self, peer, this.isDangerous) === null,
        canReceive: edgeAllows(e, peer.id, nodeId),
      });
    }
    return peers;
  }

  async sendTo(nodeId: string, raw: unknown): Promise<SendResult> {
    const parsed = sendToSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, `invalid message: peer is required and the message must have 1-${LIMITS.messageChars} characters`);
    }
    const sender = this.mustNode(nodeId);
    const edges = this.repo.edgesOf(nodeId);
    const candidates = edges
      .map((e) => this.repo.getNode(e.source === nodeId ? e.target : e.source))
      .filter((n): n is NodeWithToken => n !== null)
      .filter((n) => n.id === parsed.data.peer || n.title === parsed.data.peer);
    const unique = [...new Map(candidates.map((n) => [n.id, n])).values()];
    if (unique.length === 0) throw new HttpError(404, `no connected peer named "${parsed.data.peer}"`);
    if (unique.length > 1) throw new HttpError(409, `several peers are titled "${parsed.data.peer}"; use the peer id`);
    const receiver = unique[0]!;

    if (!findRoute(edges, sender.id, receiver.id)) {
      throw new HttpError(403, `the edge to "${receiver.title}" does not allow messages in this direction`);
    }
    const escalation = escalationError(sender, receiver, this.isDangerous);
    if (escalation) throw new HttpError(403, escalation);
    const now = Date.now();
    if (this.repo.countSentSince(sender.id, receiver.id, now - LIMITS.rateWindowMs) >= LIMITS.messagesPerWindow) {
      throw new HttpError(429, `rate limit: at most ${LIMITS.messagesPerWindow} messages per minute to the same peer`);
    }
    if (this.repo.countPendingFor(receiver.id) >= LIMITS.queuePerTarget) {
      throw new HttpError(429, `"${receiver.title}" already has ${LIMITS.queuePerTarget} queued messages`);
    }
    const body = sanitizeForTerminal(parsed.data.message);
    if (!body) throw new HttpError(400, 'message is empty after removing control characters');

    const message: Message = {
      id: randomUUID(),
      fromNode: sender.id,
      fromTitle: sender.title,
      toNode: receiver.id,
      toTitle: receiver.title,
      body,
      delivered: false,
      delivery: null,
      createdAt: now,
      deliveredAt: null,
    };
    this.repo.insertMessage(message);
    this.opts.emit('message:added', message);
    this.emitNode(receiver.id);
    const delivered = await this.deliverPending(receiver.id);
    return { status: delivered.includes(message.id) ? 'delivered' : 'queued', messageId: message.id };
  }

  readInbox(nodeId: string): InboxMessage[] {
    this.mustNode(nodeId);
    const pending = this.repo.pendingFor(nodeId);
    if (pending.length === 0) return [];
    const updated = this.repo.markDelivered(
      pending.map((m) => m.id),
      'inbox',
      Date.now(),
    );
    for (const m of updated) this.opts.emit('message:changed', m);
    this.emitNode(nodeId);
    return pending.map((m) => ({
      id: m.id,
      from: m.fromNode,
      fromTitle: m.fromTitle,
      body: m.body,
      createdAt: new Date(m.createdAt).toISOString(),
    }));
  }

  setFocus(nodeId: string | null): void {
    const previous = this.focusedNode;
    this.focusedNode = nodeId;
    if (previous && previous !== nodeId) void this.deliverPending(previous);
  }

  /**
   * Types queued messages into an idle, unfocused agent node. Never types over a busy agent or
   * over the user. Returns the ids delivered.
   */
  async deliverPending(nodeId: string): Promise<string[]> {
    if (this.delivering.has(nodeId)) return [];
    const node = this.repo.getNode(nodeId);
    if (!node || !isAgentKind(node.kind)) return [];
    if (this.repo.getStatus(nodeId).state !== 'idle' || this.focusedNode === nodeId) return [];
    const queued = this.repo.pendingFor(nodeId);
    if (queued.length === 0) return [];
    // Re-check every message: the edge may have been cut, or the sender deleted, since it was queued.
    const edges = this.repo.edgesOf(nodeId);
    const pending = queued.filter((m) => {
      const sender = this.repo.getNode(m.fromNode);
      return sender !== null && findRoute(edges, sender.id, nodeId) !== null && !escalationError(sender, node, this.isDangerous);
    });
    const revoked = queued.filter((m) => !pending.includes(m));
    if (revoked.length > 0) {
      for (const m of this.repo.discardMessages(revoked.map((r) => r.id))) this.opts.emit('message:changed', m);
      this.emitNode(nodeId);
    }
    if (pending.length === 0) return [];
    this.delivering.add(nodeId);
    try {
      // Optimistic: the prompt we type will start a turn (UserPromptSubmit confirms it).
      this.setState(nodeId, 'working');
      await this.opts.tmux.pasteAndSubmit(node.tmuxSession, formatDelivery(pending));
      const updated = this.repo.markDelivered(
        pending.map((m) => m.id),
        'pty',
        Date.now(),
      );
      for (const m of updated) this.opts.emit('message:changed', m);
      this.emitNode(nodeId);
      return pending.map((m) => m.id);
    } catch (err) {
      this.setState(nodeId, 'idle', `delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      this.delivering.delete(nodeId);
    }
  }

  listMessages(): Message[] {
    return this.repo.listMessages();
  }

  /* ------------------------------------------------------------------ accounts & usage */

  discoverAccounts(): DiscoveredDir[] {
    return discoverConfigDirs(this.opts.home, this.repo.listAccounts());
  }

  upsertAccount(raw: unknown): Account {
    const input = accountInputSchema.parse(raw);
    const configDir = resolve(input.configDir);
    if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
      throw new Error(`config directory not found: ${configDir}`);
    }
    const clash = this.repo.listAccounts().find((a) => resolve(a.configDir) === configDir && a.id !== input.id);
    if (clash) throw new Error(`this directory is already registered as "${clash.label}"`);
    const account: Account = { ...input, configDir };
    this.repo.upsertAccount(account);
    this.usageReaders.delete(account.id);
    void this.refreshUsage();
    return account;
  }

  deleteAccount(id: string): void {
    if (this.repo.countNodesForAccount(id) > 0) throw new Error('this account is used by nodes on the canvas');
    this.repo.deleteAccount(id);
    this.usageReaders.delete(id);
    this.usage.delete(id);
  }

  async refreshUsage(now = Date.now()): Promise<AccountUsage[]> {
    // Usage is read from Claude Code transcripts; other agents show "usage n/a".
    for (const account of this.repo.listAccounts().filter((a) => a.agent === 'claude')) {
      let reader = this.usageReaders.get(account.id);
      if (!reader || reader.configDir !== account.configDir) {
        reader = new UsageReader(account.configDir);
        this.usageReaders.set(account.id, reader);
      }
      const entries = await reader.refresh(now);
      this.usage.set(account.id, computeUsage(account.id, entries, now));
    }
    const all = [...this.usage.values()];
    this.opts.emit('usage:changed', all);
    return all;
  }

  saveViewport(v: Viewport): void {
    this.repo.setViewport(v);
  }

  /** Session directories left behind by deleted nodes (housekeeping on start). */
  pruneNodeDirs(): void {
    const ids = new Set(this.repo.listNodes().map((n) => n.id));
    let entries: string[] = [];
    try {
      entries = readdirSync(this.opts.paths.nodesDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!ids.has(name)) rmSync(join(this.opts.paths.nodesDir, name), { recursive: true, force: true });
    }
  }
}
