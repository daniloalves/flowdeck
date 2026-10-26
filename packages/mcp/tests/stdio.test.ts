import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BUNDLE = resolve(__dirname, '../dist/flowdeck-mcp.cjs');

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Spawns the real bundled flowdeck-mcp over stdio against a fake FlowDeck socket. */
describe('flowdeck-mcp over stdio', () => {
  let dir: string;
  let sock: string;
  let server: Server;
  const seen: Seen[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdmcp-'));
    sock = join(dir, 's.sock');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/agent/peers') res.end(JSON.stringify([{ id: 'p1', title: 'reviewer', canSend: true }]));
        else if (req.url === '/agent/send') {
          const { peer } = JSON.parse(body) as { peer: string };
          if (peer === 'stranger') {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'no connected peer named "stranger"' }));
          } else res.end(JSON.stringify({ status: 'queued', messageId: 'm1' }));
        } else res.end('[]');
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(env: Record<string, string>, extraArgs: string[] = []): Promise<Client> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BUNDLE, ...extraArgs], env, stderr: 'pipe' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

  it('exposes exactly list_peers, send_to and read_inbox', async () => {
    const client = await connect({ PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_peers', 'read_inbox', 'send_to']);
    await client.close();
  });

  it('forwards calls with the node identity headers', async () => {
    const client = await connect({
      PATH: process.env.PATH ?? '',
      ELECTRON_RUN_AS_NODE: '1',
      FLOWDECK_NODE_ID: 'node-a',
      FLOWDECK_NODE_TOKEN: 'tok',
      FLOWDECK_SOCK: sock,
    });
    expect(text(await client.callTool({ name: 'list_peers', arguments: {} }))).toContain('reviewer');
    expect(text(await client.callTool({ name: 'send_to', arguments: { peer: 'reviewer', message: 'hi' } }))).toBe(
      'queued (message m1)',
    );
    const send = seen.find((s) => s.url === '/agent/send')!;
    expect(send.headers['x-flowdeck-node']).toBe('node-a');
    expect(send.headers['x-flowdeck-token']).toBe('tok');
    expect(JSON.parse(send.body)).toEqual({ peer: 'reviewer', message: 'hi' });

    const denied = await client.callTool({ name: 'send_to', arguments: { peer: 'stranger', message: 'hi' } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('no connected peer');

    // schema-level limit, before anything reaches FlowDeck
    const tooLong = await client.callTool({ name: 'send_to', arguments: { peer: 'reviewer', message: 'x'.repeat(4001) } });
    expect(tooLong.isError).toBe(true);
    await client.close();
  });

  it('outside FlowDeck it answers with a clear error instead of crashing', async () => {
    const client = await connect({ PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1' });
    const r = await client.callTool({ name: 'list_peers', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not started by FlowDeck');
    await client.close();
  });

  it('reads the identity from a private identity.json and rejects anything else', async () => {
    const { safeIdentityPath } = await import('../src/client');
    const { chmodSync, writeFileSync } = await import('node:fs');
    const good = join(dir, 'identity.json');
    writeFileSync(good, JSON.stringify({ nodeId: 'node-b', token: 'tok-b', socketPath: sock }), { mode: 0o600 });
    expect(safeIdentityPath(good)).toBe(good);
    expect(() => safeIdentityPath('identity.json')).toThrow(/absolute/);
    expect(() => safeIdentityPath(`${dir}/../${dir.split('/').pop()}/identity.json`)).toThrow(/absolute/);
    expect(() => safeIdentityPath('/etc/passwd')).toThrow(/identity.json/);
    chmodSync(good, 0o644);
    expect(() => safeIdentityPath(good)).toThrow(/0600/);
    chmodSync(good, 0o600);

    const client = await connect({ PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1' }, ['--identity', good]);
    await client.callTool({ name: 'list_peers', arguments: {} });
    expect(seen.at(-1)?.headers['x-flowdeck-node']).toBe('node-b');
    await client.close();
  });

  it('reports an unreachable app', async () => {
    const client = await connect({
      PATH: process.env.PATH ?? '',
      ELECTRON_RUN_AS_NODE: '1',
      FLOWDECK_NODE_ID: 'n',
      FLOWDECK_NODE_TOKEN: 't',
      FLOWDECK_SOCK: join(dir, 'missing.sock'),
    });
    const r = await client.callTool({ name: 'read_inbox', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not reachable');
    await client.close();
  });
});
