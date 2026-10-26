import type {
  Account,
  Annotation,
  AnnotationPatch,
  Delivery,
  Edge,
  EdgeDirection,
  Message,
  NodeKind,
  NodeLayout,
  NodeRecord,
  NodeState,
  NodeStatus,
  Viewport,
} from '@flowdeck/shared';
import type { Db } from './database';

interface AccountRow {
  id: string;
  agent: Account['agent'];
  label: string;
  config_dir: string;
  color: string;
  cap_5h: number | null;
  cap_7d: number | null;
}

interface NodeRow {
  id: string;
  kind: NodeKind;
  title: string;
  cwd: string;
  account_id: string | null;
  tmux_session: string;
  session_id: string | null;
  launch_args: string;
  token: string;
  x: number;
  y: number;
  w: number;
  h: number;
  created_at: number;
}

interface EdgeRow {
  id: string;
  source: string;
  target: string;
  direction: EdgeDirection;
}

interface StatusRow {
  node_id: string;
  state: NodeState;
  detail: string | null;
  updated_at: number;
}

interface MessageRow {
  id: string;
  from_node: string;
  from_title: string;
  to_node: string;
  to_title: string;
  body: string;
  delivered: number;
  delivery: Delivery | null;
  created_at: number;
  delivered_at: number | null;
}

interface AnnotationRow {
  id: string;
  kind: Annotation['kind'];
  text: string;
  color: string;
  font_size: number;
  x: number;
  y: number;
  w: number;
  h: number;
  created_at: number;
}

export interface NodeWithToken extends NodeRecord {
  token: string;
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  agent: r.agent,
  label: r.label,
  configDir: r.config_dir,
  color: r.color,
  cap5h: r.cap_5h,
  cap7d: r.cap_7d,
});

function parseArgs(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const toNode = (r: NodeRow): NodeWithToken => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  cwd: r.cwd,
  accountId: r.account_id,
  tmuxSession: r.tmux_session,
  sessionId: r.session_id,
  launchArgs: parseArgs(r.launch_args),
  token: r.token,
  x: r.x,
  y: r.y,
  w: r.w,
  h: r.h,
  createdAt: r.created_at,
});

const toAnnotation = (r: AnnotationRow): Annotation => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  color: r.color,
  fontSize: r.font_size,
  x: r.x,
  y: r.y,
  w: r.w,
  h: r.h,
  createdAt: r.created_at,
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  fromNode: r.from_node,
  fromTitle: r.from_title,
  toNode: r.to_node,
  toTitle: r.to_title,
  body: r.body,
  delivered: r.delivered === 1,
  delivery: r.delivery,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
});

/** All SQL lives here. Methods are synchronous (better-sqlite3). */
export class Repo {
  constructor(readonly db: Db) {}

  /* accounts */

  listAccounts(): Account[] {
    return (this.db.prepare('SELECT * FROM account ORDER BY label').all() as AccountRow[]).map(toAccount);
  }

  getAccount(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM account WHERE id = ?').get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  upsertAccount(a: Account): void {
    this.db
      .prepare(
        `INSERT INTO account (id, agent, label, config_dir, color, cap_5h, cap_7d)
         VALUES (@id, @agent, @label, @configDir, @color, @cap5h, @cap7d)
         ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, label = excluded.label,
           config_dir = excluded.config_dir, color = excluded.color, cap_5h = excluded.cap_5h,
           cap_7d = excluded.cap_7d`,
      )
      .run(a);
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM account WHERE id = ?').run(id);
  }

  countNodesForAccount(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM node WHERE account_id = ?').get(id) as { n: number }).n;
  }

  /* nodes */

  listNodes(): NodeWithToken[] {
    return (this.db.prepare('SELECT * FROM node ORDER BY created_at').all() as NodeRow[]).map(toNode);
  }

  getNode(id: string): NodeWithToken | null {
    const row = this.db.prepare('SELECT * FROM node WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? toNode(row) : null;
  }

  insertNode(n: NodeWithToken, status: NodeStatus): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO node (id, kind, title, cwd, account_id, tmux_session, session_id, launch_args,
             token, x, y, w, h, created_at)
           VALUES (@id, @kind, @title, @cwd, @accountId, @tmuxSession, @sessionId, @launchArgs,
             @token, @x, @y, @w, @h, @createdAt)`,
        )
        .run({ ...n, launchArgs: JSON.stringify(n.launchArgs) });
      this.setStatus(n.id, status);
    })();
  }

  updateNodeTitle(id: string, title: string): void {
    this.db.prepare('UPDATE node SET title = ? WHERE id = ?').run(title, id);
  }

  updateNodeLayout(id: string, l: NodeLayout): void {
    this.db.prepare('UPDATE node SET x = @x, y = @y, w = @w, h = @h WHERE id = @id').run({ id, ...l });
  }

  setToken(id: string, token: string): void {
    this.db.prepare('UPDATE node SET token = ? WHERE id = ?').run(token, id);
  }

  setSessionId(id: string, sessionId: string | null): void {
    this.db.prepare('UPDATE node SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  deleteNode(id: string): void {
    this.db.prepare('DELETE FROM node WHERE id = ?').run(id);
  }

  /* status */

  getStatus(id: string): NodeStatus {
    const row = this.db.prepare('SELECT * FROM node_status WHERE node_id = ?').get(id) as StatusRow | undefined;
    return row
      ? { state: row.state, detail: row.detail, updatedAt: row.updated_at }
      : { state: 'unknown', detail: null, updatedAt: 0 };
  }

  setStatus(id: string, s: NodeStatus): void {
    this.db
      .prepare(
        `INSERT INTO node_status (node_id, state, detail, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, detail = excluded.detail,
           updated_at = excluded.updated_at`,
      )
      .run(id, s.state, s.detail, s.updatedAt);
  }

  /* edges */

  listEdges(): Edge[] {
    return this.db.prepare('SELECT id, source, target, direction FROM edge ORDER BY created_at').all() as EdgeRow[];
  }

  getEdge(id: string): Edge | null {
    return (this.db.prepare('SELECT id, source, target, direction FROM edge WHERE id = ?').get(id) as EdgeRow) ?? null;
  }

  insertEdge(e: Edge): void {
    this.db
      .prepare('INSERT INTO edge (id, source, target, direction, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(e.id, e.source, e.target, e.direction, Date.now());
  }

  deleteEdge(id: string): void {
    this.db.prepare('DELETE FROM edge WHERE id = ?').run(id);
  }

  edgesOf(nodeId: string): Edge[] {
    return this.db
      .prepare('SELECT id, source, target, direction FROM edge WHERE source = ? OR target = ?')
      .all(nodeId, nodeId) as EdgeRow[];
  }

  /* messages */

  insertMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO message (id, from_node, from_title, to_node, to_title, body, delivered, delivery,
           created_at, delivered_at)
         VALUES (@id, @fromNode, @fromTitle, @toNode, @toTitle, @body, @delivered, @delivery,
           @createdAt, @deliveredAt)`,
      )
      .run({ ...m, delivered: m.delivered ? 1 : 0 });
  }

  pendingFor(nodeId: string): Message[] {
    return (
      this.db
        .prepare('SELECT * FROM message WHERE to_node = ? AND delivered = 0 ORDER BY created_at, rowid')
        .all(nodeId) as MessageRow[]
    ).map(toMessage);
  }

  countPendingFor(nodeId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM message WHERE to_node = ? AND delivered = 0').get(nodeId) as {
        n: number;
      }
    ).n;
  }

  countSentSince(from: string, to: string, since: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM message WHERE from_node = ? AND to_node = ? AND created_at >= ?')
        .get(from, to, since) as { n: number }
    ).n;
  }

  markDelivered(ids: string[], delivery: Delivery, at: number): Message[] {
    const stmt = this.db.prepare(
      'UPDATE message SET delivered = 1, delivery = ?, delivered_at = ? WHERE id = ? AND delivered = 0',
    );
    const get = this.db.prepare('SELECT * FROM message WHERE id = ?');
    return this.db.transaction(() =>
      ids.map((id) => {
        stmt.run(delivery, at, id);
        return toMessage(get.get(id) as MessageRow);
      }),
    )();
  }

  /** Marks queued messages as handled without delivery (route revoked). */
  discardMessages(ids: string[]): Message[] {
    const stmt = this.db.prepare('UPDATE message SET delivered = 1, delivery = NULL, delivered_at = ? WHERE id = ? AND delivered = 0');
    const get = this.db.prepare('SELECT * FROM message WHERE id = ?');
    const now = Date.now();
    return this.db.transaction(() =>
      ids.map((id) => {
        stmt.run(now, id);
        return toMessage(get.get(id) as MessageRow);
      }),
    )();
  }

  /** Messages addressed to a deleted node can never be delivered; drop them from the queue. */
  discardPendingFor(nodeId: string): void {
    this.db.prepare('UPDATE message SET delivered = 1, delivery = NULL WHERE to_node = ? AND delivered = 0').run(nodeId);
  }

  listMessages(limit = 500): Message[] {
    return (
      this.db.prepare('SELECT * FROM message ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as MessageRow[]
    ).map(toMessage);
  }

  /* annotations */

  listAnnotations(): Annotation[] {
    return (this.db.prepare('SELECT * FROM annotation ORDER BY created_at, rowid').all() as AnnotationRow[]).map(
      toAnnotation,
    );
  }

  countAnnotations(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM annotation').get() as { n: number }).n;
  }

  getAnnotation(id: string): Annotation | null {
    const row = this.db.prepare('SELECT * FROM annotation WHERE id = ?').get(id) as AnnotationRow | undefined;
    return row ? toAnnotation(row) : null;
  }

  insertAnnotation(a: Annotation): void {
    this.db
      .prepare(
        `INSERT INTO annotation (id, kind, text, color, font_size, x, y, w, h, created_at)
         VALUES (@id, @kind, @text, @color, @fontSize, @x, @y, @w, @h, @createdAt)`,
      )
      .run(a);
  }

  updateAnnotation(id: string, patch: AnnotationPatch): void {
    const current = this.getAnnotation(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare('UPDATE annotation SET text = ?, color = ?, font_size = ?, x = ?, y = ?, w = ?, h = ? WHERE id = ?')
      .run(next.text, next.color, next.fontSize, next.x, next.y, next.w, next.h, id);
  }

  deleteAnnotation(id: string): void {
    this.db.prepare('DELETE FROM annotation WHERE id = ?').run(id);
  }

  /* app state */

  getViewport(): Viewport | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = 'viewport'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as Viewport;
    } catch {
      return null;
    }
  }

  setViewport(v: Viewport): void {
    this.db
      .prepare(
        "INSERT INTO app_state (key, value) VALUES ('viewport', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(v));
  }
}
