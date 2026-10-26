import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { USAGE } from '@flowdeck/shared';
import { parseUsageLine, type UsageEntry } from './parser';

interface FileState {
  offset: number;
  mtimeMs: number;
  /** Incomplete trailing line from the previous read. */
  partial: string;
}

const MAX_DEPTH = 5;
const MAX_FILES = 20_000;

/**
 * Incremental reader for `<configDir>/projects/**\/*.jsonl`. Each refresh only reads bytes appended
 * since the last one, skips files untouched for longer than the 7-day window and deduplicates
 * streaming duplicates by message id + request id.
 */
export class UsageReader {
  private files = new Map<string, FileState>();
  private entries = new Map<string, UsageEntry>();
  private anonymous: UsageEntry[] = [];

  constructor(readonly configDir: string) {}

  async refresh(now = Date.now()): Promise<UsageEntry[]> {
    const horizon = now - USAGE.weekMs - USAGE.blockMs;
    const seen = new Set<string>();
    for (const file of await this.listFiles()) {
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (info.mtimeMs < horizon) continue;
      seen.add(file);
      const state = this.files.get(file);
      if (state && state.mtimeMs === info.mtimeMs && state.offset === info.size) continue;
      // A file that shrank was rewritten: read it again from the start.
      const start = state && info.size >= state.offset ? state.offset : 0;
      const partial = state && start > 0 ? state.partial : '';
      const next = await this.readFrom(file, start, partial);
      this.files.set(file, { offset: next.offset, mtimeMs: info.mtimeMs, partial: next.partial });
    }
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
    this.prune(horizon);
    return [...this.entries.values(), ...this.anonymous];
  }

  private add(entry: UsageEntry): void {
    if (entry.key === null) this.anonymous.push(entry);
    else if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry);
  }

  private prune(horizon: number): void {
    for (const [k, e] of this.entries) if (e.timestamp < horizon) this.entries.delete(k);
    this.anonymous = this.anonymous.filter((e) => e.timestamp >= horizon);
  }

  private readFrom(file: string, start: number, partial: string): Promise<{ offset: number; partial: string }> {
    return new Promise((resolve) => {
      let offset = start;
      let rest = partial;
      const stream = createReadStream(file, { start, encoding: 'utf8' });
      stream.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        offset += Buffer.byteLength(text);
        const lines = (rest + text).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) {
          const entry = parseUsageLine(line);
          if (entry) this.add(entry);
        }
        // Protect memory against a pathological line without newlines.
        if (rest.length > 8 * 1024 * 1024) rest = '';
      });
      stream.on('end', () => resolve({ offset, partial: rest }));
      stream.on('error', () => resolve({ offset: start, partial }));
    });
  }

  private async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      }
    };
    await walk(join(this.configDir, 'projects'), 0);
    return out;
  }
}
