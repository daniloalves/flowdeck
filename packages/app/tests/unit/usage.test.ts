import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUsageLine, type UsageEntry } from '../../src/main/usage/parser';
import { UsageReader } from '../../src/main/usage/reader';
import { computeUsage, countedTokens } from '../../src/main/usage/windows';
import { tempDir } from '../helpers';

const H = 60 * 60 * 1000;

const line = (ts: string, id: string, req: string, input: number, output: number, extra = '') =>
  `{"type":"assistant","timestamp":"${ts}","requestId":"${req}","message":{"id":"${id}","model":"m","usage":{"input_tokens":${input},"output_tokens":${output},"cache_creation_input_tokens":7,"cache_read_input_tokens":11}}${extra}}`;

const entry = (timestamp: number, input = 10, output = 5): UsageEntry => ({
  timestamp,
  key: null,
  inputTokens: input,
  outputTokens: output,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

describe('parseUsageLine', () => {
  it('reads assistant usage', () => {
    const e = parseUsageLine(line('2026-10-23T10:00:00.000Z', 'msg_1', 'req_1', 3, 4));
    expect(e).toEqual({
      timestamp: Date.parse('2026-10-23T10:00:00.000Z'),
      key: 'msg_1:req_1',
      inputTokens: 3,
      outputTokens: 4,
      cacheCreationTokens: 7,
      cacheReadTokens: 11,
    });
  });

  it('ignores user lines, malformed JSON and bad timestamps', () => {
    expect(parseUsageLine('{"type":"user","message":{"usage":{}}}')).toBeNull();
    expect(parseUsageLine('{"type":"assistant","usage"')).toBeNull();
    expect(parseUsageLine(line('not-a-date', 'm', 'r', 1, 1))).toBeNull();
  });

  it('treats negative or non-numeric counts as zero', () => {
    const e = parseUsageLine(
      '{"type":"assistant","timestamp":"2026-10-23T10:00:00Z","message":{"usage":{"input_tokens":-5,"output_tokens":"9"}}}',
    );
    expect(e?.inputTokens).toBe(0);
    expect(e?.outputTokens).toBe(0);
    expect(e?.key).toBeNull();
  });
});

describe('computeUsage (5 h block + 7 days)', () => {
  const now = Date.parse('2026-10-23T12:30:00.000Z');

  it('block starts at the hour of the first message and is active within 5 h', () => {
    const u = computeUsage('a', [entry(now - 2 * H), entry(now - 1 * H)], now);
    expect(u.block?.start).toBe(Date.parse('2026-10-23T10:00:00.000Z'));
    expect(u.block?.end).toBe(Date.parse('2026-10-23T15:00:00.000Z'));
    expect(countedTokens(u.block!)).toBe(30);
  });

  it('a message after the block end starts a new block', () => {
    const u = computeUsage('a', [entry(now - 6 * H, 1000, 0), entry(now - 10 * 60 * 1000)], now);
    expect(countedTokens(u.block!)).toBe(15);
    expect(countedTokens(u.week)).toBe(1015);
  });

  it('no active block after 5 h of inactivity', () => {
    expect(computeUsage('a', [entry(now - 6 * H)], now).block).toBeNull();
  });

  it('7-day window excludes older messages', () => {
    const u = computeUsage('a', [entry(now - 8 * 24 * H, 999, 999), entry(now - H)], now);
    expect(countedTokens(u.week)).toBe(15);
  });
});

describe('UsageReader', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('deduplicates streaming duplicates and reads appended lines incrementally', async () => {
    dir = tempDir();
    const project = join(dir, 'projects', '-p');
    mkdirSync(join(project, 'sub', 'subagents'), { recursive: true });
    const file = join(project, 's.jsonl');
    const ts = new Date().toISOString();
    writeFileSync(file, `${line(ts, 'm1', 'r1', 100, 10)}\n${line(ts, 'm1', 'r1', 100, 10)}\n{"type":"user"}\n`);
    writeFileSync(join(project, 'sub', 'subagents', 'a.jsonl'), `${line(ts, 'm2', 'r2', 1, 1)}\n`);

    const reader = new UsageReader(dir);
    let entries = await reader.refresh();
    expect(entries.map((e) => e.key).sort()).toEqual(['m1:r1', 'm2:r2']);

    // A partial line is kept until its newline arrives.
    const next = line(ts, 'm3', 'r3', 5, 5);
    appendFileSync(file, next.slice(0, 40));
    entries = await reader.refresh();
    expect(entries).toHaveLength(2);
    appendFileSync(file, `${next.slice(40)}\n`);
    entries = await reader.refresh();
    expect(entries.map((e) => e.key).sort()).toEqual(['m1:r1', 'm2:r2', 'm3:r3']);
  });

  it('handles a missing projects directory', async () => {
    dir = tempDir();
    expect(await new UsageReader(dir).refresh()).toEqual([]);
  });
});
