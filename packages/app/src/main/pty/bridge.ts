import { spawn, type IPty } from 'node-pty';
import type { Tmux } from '../tmux/tmux';

export interface PtySink {
  data(nodeId: string, data: string): void;
  exit(nodeId: string): void;
}

interface Client {
  pty: IPty;
  buffer: string;
  timer: NodeJS.Timeout | null;
}

const FLUSH_MS = 8;
const MAX_BUFFER = 256 * 1024;

/**
 * One `tmux attach` client per visible node. Closing a client detaches from the tmux session;
 * the program inside keeps running. Output is batched to keep IPC traffic low.
 */
export class PtyBridge {
  private clients = new Map<string, Client>();

  constructor(
    private readonly tmux: Tmux,
    private readonly sink: PtySink,
  ) {}

  open(nodeId: string, session: string, cols: number, rows: number): void {
    this.close(nodeId);
    const pty = spawn(this.tmux.opts.bin, this.tmux.attachArgs(session), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME ?? '/',
      env: this.tmux.opts.env as Record<string, string>,
    });
    const client: Client = { pty, buffer: '', timer: null };
    this.clients.set(nodeId, client);
    pty.onData((data) => {
      client.buffer += data;
      if (client.buffer.length >= MAX_BUFFER) this.flush(nodeId, client);
      else client.timer ??= setTimeout(() => this.flush(nodeId, client), FLUSH_MS);
    });
    pty.onExit(() => {
      this.flush(nodeId, client);
      if (this.clients.get(nodeId) === client) {
        this.clients.delete(nodeId);
        this.sink.exit(nodeId);
      }
    });
  }

  write(nodeId: string, data: string): void {
    this.clients.get(nodeId)?.pty.write(data);
  }

  resize(nodeId: string, cols: number, rows: number): void {
    try {
      this.clients.get(nodeId)?.pty.resize(cols, rows);
    } catch {
      /* the client may have exited between the check and the call */
    }
  }

  isOpen(nodeId: string): boolean {
    return this.clients.has(nodeId);
  }

  close(nodeId: string): void {
    const client = this.clients.get(nodeId);
    if (!client) return;
    this.clients.delete(nodeId);
    if (client.timer) clearTimeout(client.timer);
    try {
      client.pty.kill();
    } catch {
      /* already gone */
    }
  }

  closeAll(): void {
    for (const id of [...this.clients.keys()]) this.close(id);
  }

  private flush(nodeId: string, client: Client): void {
    if (client.timer) {
      clearTimeout(client.timer);
      client.timer = null;
    }
    if (!client.buffer) return;
    const data = client.buffer;
    client.buffer = '';
    this.sink.data(nodeId, data);
  }
}
