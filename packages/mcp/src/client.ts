import { lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import { request } from 'node:http';
import { HEADER, type InboxMessage, type PeerInfo, type SendResult } from '@flowdeck/shared';

export interface NodeIdentity {
  nodeId: string;
  token: string;
  socketPath: string;
}

/** Thin HTTP-over-Unix-socket client for the FlowDeck agent API. */
export class AppClient {
  constructor(
    private readonly identity: NodeIdentity,
    private readonly timeoutMs = 5000,
  ) {}

  listPeers(): Promise<PeerInfo[]> {
    return this.call<PeerInfo[]>('GET', '/agent/peers');
  }

  sendTo(peer: string, message: string): Promise<SendResult> {
    return this.call<SendResult>('POST', '/agent/send', { peer, message });
  }

  readInbox(): Promise<InboxMessage[]> {
    return this.call<InboxMessage[]>('POST', '/agent/inbox', {});
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      // Plain HTTP is intentional: only FlowDeck's 0600 Unix domain socket (socketPath), never the network.
      const req = request(
        {
          socketPath: this.identity.socketPath,
          path,
          method,
          timeout: this.timeoutMs,
          headers: {
            [HEADER.node]: this.identity.nodeId,
            [HEADER.token]: this.identity.token,
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              reject(new Error(`FlowDeck returned an invalid response (${res.statusCode})`));
              return;
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed as T);
            } else {
              const error = (parsed as { error?: unknown } | null)?.error;
              reject(new Error(typeof error === 'string' ? error : `FlowDeck error ${res.statusCode}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('FlowDeck did not answer in time')));
      req.on('error', (err) =>
        reject(new Error(`FlowDeck is not reachable (${(err as NodeJS.ErrnoException).code ?? err.message})`)),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }
}

/**
 * Only FlowDeck's own identity files are accepted: an absolute, normalised path to a regular
 * `identity.json` owned by this user and unreadable by anyone else (FlowDeck writes it 0600).
 */
export function safeIdentityPath(candidate: string | undefined): string {
  if (!candidate || candidate.includes('\0')) throw new Error('--identity needs a file path');
  if (!isAbsolute(candidate) || normalize(candidate) !== candidate || basename(candidate) !== 'identity.json') {
    throw new Error('--identity must be an absolute path to identity.json');
  }
  const info = lstatSync(candidate);
  if (!info.isFile()) throw new Error('identity file is not a regular file');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('identity file has another owner');
  if ((info.mode & 0o077) !== 0) throw new Error('identity file must not be readable by others (expected 0600)');
  return candidate;
}

/**
 * Reads the node identity from `--identity <file>` (preferred: argv then only carries a path), or
 * from the environment for older launches.
 */
export function resolveIdentity(argv: string[], env: NodeJS.ProcessEnv): NodeIdentity | null {
  const i = argv.indexOf('--identity');
  if (i >= 0) {
    const file = safeIdentityPath(argv[i + 1]);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeIdentity>;
    if (typeof parsed.nodeId !== 'string' || typeof parsed.token !== 'string' || typeof parsed.socketPath !== 'string') {
      throw new Error(`invalid identity file: ${file}`);
    }
    return { nodeId: parsed.nodeId, token: parsed.token, socketPath: parsed.socketPath };
  }
  if (env.FLOWDECK_IDENTITY) return resolveIdentity(['--identity', env.FLOWDECK_IDENTITY], {});
  return identityFromEnv(env);
}

export function identityFromEnv(env: NodeJS.ProcessEnv): NodeIdentity | null {
  const nodeId = env.FLOWDECK_NODE_ID;
  const token = env.FLOWDECK_NODE_TOKEN;
  const socketPath = env.FLOWDECK_SOCK;
  if (!nodeId || !token || !socketPath) return null;
  return { nodeId, token, socketPath };
}
