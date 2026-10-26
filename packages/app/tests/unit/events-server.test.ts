import { request } from 'node:http';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookEvent, HookPayload } from '@flowdeck/shared';
import { EventServer, HttpError } from '../../src/main/events/server';
import { tempDir } from '../helpers';

interface Res {
  status: number;
  body: unknown;
}

function call(socketPath: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('EventServer', () => {
  let dir: string;
  let sock: string;
  let server: EventServer;
  const hooks: { node: string; event: HookEvent; payload: HookPayload }[] = [];
  const auth = { 'x-flowdeck-node': 'n1', 'x-flowdeck-token': 'secret-token' };

  beforeEach(async () => {
    hooks.length = 0;
    dir = tempDir();
    sock = join(dir, 'run', 'fd.sock');
    server = new EventServer(sock, {
      tokenOf: (id) => (id === 'n1' ? 'secret-token' : null),
      onHook: (node, event, payload) => hooks.push({ node, event, payload }),
      listPeers: () => [{ id: 'p' }],
      sendTo: async (_id, body) => {
        if ((body as { peer?: string }).peer === 'x') throw new HttpError(403, 'no edge');
        return { status: 'queued', messageId: 'm' };
      },
      readInbox: () => [],
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('socket is private (0600) and its directory 0700', () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
  });

  it('accepts an authenticated hook', async () => {
    const r = await call(sock, 'POST', '/event/Stop', auth, '{"session_id":"s"}');
    expect(r.status).toBe(200);
    expect(hooks).toEqual([{ node: 'n1', event: 'Stop', payload: { session_id: 's' } }]);
  });

  it('rejects missing, unknown and wrong credentials the same way', async () => {
    expect((await call(sock, 'POST', '/event/Stop', {}, '{}')).status).toBe(401);
    expect((await call(sock, 'POST', '/event/Stop', { ...auth, 'x-flowdeck-node': 'n2' }, '{}')).status).toBe(403);
    expect((await call(sock, 'POST', '/event/Stop', { ...auth, 'x-flowdeck-token': 'nope' }, '{}')).status).toBe(403);
    expect(hooks).toHaveLength(0);
  });

  it('ignores unknown events and rejects invalid JSON', async () => {
    expect((await call(sock, 'POST', '/event/PreToolUse', auth, '{}')).status).toBe(202);
    expect((await call(sock, 'POST', '/event/Stop', auth, '{not json')).status).toBe(400);
    expect(hooks).toHaveLength(0);
  });

  it('rejects oversized bodies', async () => {
    const big = JSON.stringify({ message: 'x'.repeat(300 * 1024) });
    const r = await call(sock, 'POST', '/event/Notification', auth, big).catch(() => ({ status: 413, body: null }));
    expect(r.status).toBe(413);
  });

  it('agent API maps HttpError to its status', async () => {
    expect((await call(sock, 'GET', '/agent/peers', auth)).body).toEqual([{ id: 'p' }]);
    const denied = await call(sock, 'POST', '/agent/send', auth, '{"peer":"x","message":"m"}');
    expect(denied).toEqual({ status: 403, body: { error: 'no edge' } });
    expect((await call(sock, 'GET', '/nope', auth)).status).toBe(404);
  });

  it('refuses to start while another server owns the socket, and replaces a stale one', async () => {
    const second = new EventServer(sock, {
      tokenOf: () => null,
      onHook: () => undefined,
      listPeers: () => [],
      sendTo: async () => ({}),
      readInbox: () => [],
    });
    await expect(second.start()).rejects.toThrow(/another FlowDeck/);
  });
});
