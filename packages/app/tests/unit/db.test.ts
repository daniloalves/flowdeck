import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/main/db/database';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { Repo, type NodeWithToken } from '../../src/main/db/repo';

function memoryRepo(): Repo {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return new Repo(db);
}

const node = (id: string, accountId: string | null = 'work'): NodeWithToken => ({
  id,
  kind: accountId ? 'claude' : 'shell',
  title: `node ${id}`,
  cwd: '/tmp',
  accountId,
  tmuxSession: `fd-${id}0000`,
  sessionId: null,
  launchArgs: ['--model', 'sonnet'],
  token: 't'.repeat(64),
  x: 10,
  y: 20,
  w: 700,
  h: 400,
  createdAt: Date.now(),
});

describe('database', () => {
  it('migrates to the latest version and is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });

  it('migrates a v1 database with data to v2 without losing anything', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS[0]!);
    db.pragma('user_version = 1');
    db.exec(`
      INSERT INTO account VALUES ('work', 'Work', '/h/.claude-work', '#ffffff', NULL, 5);
      INSERT INTO node VALUES ('a', 'claude', 'A', '/p', 'work', 'fd-aaaa1111', 'sid-a', '[]', 'tok', 1, 2, 300, 200, 10);
      INSERT INTO node VALUES ('b', 'shell', 'B', '/p', NULL, 'fd-bbbb2222', NULL, '[]', 'tok2', 3, 4, 300, 200, 11);
      INSERT INTO edge VALUES ('e', 'a', 'b', 'both', 12);
      INSERT INTO node_status VALUES ('a', 'idle', NULL, 13);
    `);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const repo = new Repo(db);
    expect(repo.getNode('a')).toMatchObject({ kind: 'claude', sessionId: 'sid-a', accountId: 'work', x: 1, token: 'tok' });
    expect(repo.getAccount('work')).toMatchObject({ agent: 'claude', cap7d: 5 });
    expect(repo.listEdges()).toEqual([{ id: 'e', source: 'a', target: 'b', direction: 'both' }]);
    expect(repo.getStatus('a').state).toBe('idle');
    // new kinds are accepted, and foreign keys still cascade after the rebuild
    repo.insertNode({ ...node('c', null), kind: 'kiro' }, { state: 'idle', detail: null, updatedAt: 1 });
    repo.deleteNode('a');
    expect(repo.listEdges()).toEqual([]);
    expect(() => db.exec("INSERT INTO node VALUES ('x','vim','X','/p',NULL,'fd-xxxx3333',NULL,'[]','t',0,0,300,200,1)")).toThrow(/CHECK/);
  });

  it('migrates a v2 database to v3: drawings table, existing data untouched', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.pragma('user_version = 2');
    db.exec("INSERT INTO node VALUES ('a','shell','A','/p',NULL,'fd-aaaa1111',NULL,'[]','tok',1,2,300,200,10)");
    migrate(db);
    const repo = new Repo(db);
    expect(repo.getNode('a')).toMatchObject({ title: 'A' });
    expect(repo.listAnnotations()).toEqual([]);
    expect(() =>
      db.exec("INSERT INTO annotation VALUES ('x','circle','','#ffffff',16,0,0,10,10,1)"),
    ).toThrow(/CHECK/);
  });

  it('round-trips groups and texts; updates merge; deletes', () => {
    const repo = memoryRepo();
    const base = { text: '', color: '#7c6cf2', fontSize: 20, x: 0, y: 0, w: 400, h: 300, createdAt: 1 };
    repo.insertAnnotation({ ...base, id: 'g', kind: 'group', text: 'Team' });
    repo.insertAnnotation({ ...base, id: 't', kind: 'text', text: 'line 1\nline 2', createdAt: 2 });
    expect(repo.listAnnotations().map((a) => [a.id, a.kind, a.text])).toEqual([
      ['g', 'group', 'Team'],
      ['t', 'text', 'line 1\nline 2'],
    ]);
    repo.updateAnnotation('g', { x: 50, color: '#3ecf72' });
    expect(repo.getAnnotation('g')).toMatchObject({ x: 50, y: 0, w: 400, color: '#3ecf72', text: 'Team' });
    expect(repo.countAnnotations()).toBe(2);
    repo.deleteAnnotation('t');
    expect(repo.listAnnotations().map((a) => a.id)).toEqual(['g']);
  });

  it('refuses a schema newer than the build', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
  });

  it('round-trips nodes, layout and status', () => {
    const repo = memoryRepo();
    repo.upsertAccount({ id: 'work', agent: 'claude', label: 'Work', configDir: '/h/.claude-work', color: '#ffffff', cap5h: null, cap7d: 10 });
    repo.insertNode(node('a'), { state: 'starting', detail: null, updatedAt: 1 });
    repo.updateNodeLayout('a', { x: 1, y: 2, w: 300, h: 200 });
    repo.setStatus('a', { state: 'idle', detail: 'x', updatedAt: 2 });
    repo.setSessionId('a', 'sid');
    expect(repo.getNode('a')).toMatchObject({ x: 1, y: 2, w: 300, h: 200, sessionId: 'sid', launchArgs: ['--model', 'sonnet'] });
    expect(repo.getStatus('a')).toEqual({ state: 'idle', detail: 'x', updatedAt: 2 });
    expect(repo.getStatus('missing').state).toBe('unknown');
  });

  it('cannot delete an account used by a node; edges cascade with nodes', () => {
    const repo = memoryRepo();
    repo.upsertAccount({ id: 'work', agent: 'claude', label: 'Work', configDir: '/w', color: '#ffffff', cap5h: null, cap7d: null });
    repo.insertNode(node('a'), { state: 'idle', detail: null, updatedAt: 1 });
    repo.insertNode(node('b'), { state: 'idle', detail: null, updatedAt: 1 });
    repo.insertEdge({ id: 'e', source: 'a', target: 'b', direction: 'both' });
    expect(() => repo.deleteAccount('work')).toThrow();
    repo.deleteNode('a');
    expect(repo.listEdges()).toEqual([]);
  });

  it('messages: queue, deliver once, log survives node deletion', () => {
    const repo = memoryRepo();
    const m = {
      id: 'm1',
      fromNode: 'a',
      fromTitle: 'A',
      toNode: 'b',
      toTitle: 'B',
      body: 'hi',
      delivered: false,
      delivery: null,
      createdAt: 1,
      deliveredAt: null,
    };
    repo.insertMessage(m);
    expect(repo.countPendingFor('b')).toBe(1);
    repo.markDelivered(['m1'], 'pty', 5);
    repo.markDelivered(['m1'], 'inbox', 6); // second delivery is a no-op
    expect(repo.listMessages()[0]).toMatchObject({ delivered: true, delivery: 'pty', deliveredAt: 5 });
    expect(repo.countSentSince('a', 'b', 0)).toBe(1);
  });

  it('stores the viewport', () => {
    const repo = memoryRepo();
    expect(repo.getViewport()).toBeNull();
    repo.setViewport({ x: 1, y: 2, zoom: 0.5 });
    expect(repo.getViewport()).toEqual({ x: 1, y: 2, zoom: 0.5 });
  });
});
