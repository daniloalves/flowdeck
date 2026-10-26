import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { HEADER, LIMITS, hookPayloadSchema, type HookEvent, type HookPayload } from '@flowdeck/shared';
import { isHookEvent } from './state';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface EventHandlers {
  /** Returns the node's token, or null for unknown nodes. */
  tokenOf(nodeId: string): string | null;
  onHook(nodeId: string, event: HookEvent, payload: HookPayload): void;
  listPeers(nodeId: string): unknown;
  sendTo(nodeId: string, body: unknown): Promise<unknown>;
  readInbox(nodeId: string): unknown;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new HttpError(413, 'body too large'));
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Is another process already serving on this socket? */
function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

/**
 * HTTP server bound to a Unix socket (mode 0600). Receives Claude Code hooks from `hook.sh` and
 * agent API calls from `flowdeck-mcp`. No TCP port is ever opened.
 */
export class EventServer {
  private server: Server | null = null;

  constructor(
    readonly socketPath: string,
    private readonly handlers: EventHandlers,
  ) {}

  async start(): Promise<void> {
    const dir = dirname(this.socketPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      if (await socketAlive(this.socketPath)) throw new Error(`another FlowDeck is listening on ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    // Plain HTTP is intentional: the server binds only to a 0600 Unix domain socket, so traffic never
    // leaves the kernel and TLS would add nothing (Snyk CWE-319 finding reviewed: false positive).
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) send(res, err.status, { error: err.message });
        else send(res, 500, { error: 'internal error' });
      });
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10_000;
    server.maxHeadersCount = 30;
    // Create the socket with no group/other permissions from the start (no chmod race).
    const previous = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(previous);
    }
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* already gone */
      }
    }
  }

  private authenticate(req: IncomingMessage): string {
    const nodeId = req.headers[HEADER.node];
    const token = req.headers[HEADER.token];
    if (typeof nodeId !== 'string' || typeof token !== 'string' || !nodeId || !token) {
      throw new HttpError(401, 'missing node credentials');
    }
    const expected = this.handlers.tokenOf(nodeId);
    // Same response for unknown node and wrong token: do not reveal which ids exist.
    if (!expected || !safeEqual(expected, token)) throw new HttpError(403, 'forbidden');
    return nodeId;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://flowdeck');
    const nodeId = this.authenticate(req);

    const eventMatch = /^\/event\/([A-Za-z]+)$/.exec(url.pathname);
    if (eventMatch && req.method === 'POST') {
      const name = eventMatch[1]!;
      const raw = await readBody(req, LIMITS.bodyBytes);
      if (!isHookEvent(name)) {
        send(res, 202, { ignored: true });
        return;
      }
      const parsed = hookPayloadSchema.safeParse(parseJson(raw));
      if (!parsed.success) throw new HttpError(400, 'invalid hook payload');
      this.handlers.onHook(nodeId, name, parsed.data);
      send(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/agent/peers' && req.method === 'GET') {
      send(res, 200, this.handlers.listPeers(nodeId));
      return;
    }
    if (url.pathname === '/agent/send' && req.method === 'POST') {
      const body = parseJson(await readBody(req, 64 * 1024));
      send(res, 200, await this.handlers.sendTo(nodeId, body));
      return;
    }
    if (url.pathname === '/agent/inbox' && req.method === 'POST') {
      await readBody(req, 1024);
      send(res, 200, this.handlers.readInbox(nodeId));
      return;
    }
    throw new HttpError(404, 'not found');
  }
}
