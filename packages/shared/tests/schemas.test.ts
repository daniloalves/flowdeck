import { describe, expect, it } from 'vitest';
import { accountInputSchema, launchArgsSchema, newNodeSchema, sendToSchema, titleSchema } from '../src';

describe('input schemas', () => {
  it('titles reject control characters (they are typed into terminals)', () => {
    expect(titleSchema.safeParse('leader').success).toBe(true);
    expect(titleSchema.safeParse('evil\x1b[2J').success).toBe(false);
    expect(titleSchema.safeParse('x'.repeat(81)).success).toBe(false);
  });

  it('nodes need an absolute cwd', () => {
    const base = { kind: 'shell', title: 't', accountId: null };
    expect(newNodeSchema.safeParse({ ...base, cwd: '/tmp' }).success).toBe(true);
    expect(newNodeSchema.safeParse({ ...base, cwd: 'relative/dir' }).success).toBe(false);
  });

  it('launch args are bounded', () => {
    expect(launchArgsSchema.safeParse(Array(17).fill('--x')).success).toBe(false);
    expect(launchArgsSchema.safeParse(['--model\nrm']).success).toBe(false);
  });

  it('account ids are slugs and colours are hex', () => {
    const ok = { id: 'work', label: 'Work', configDir: '/h/.claude-work', color: '#aabbcc' };
    expect(accountInputSchema.safeParse(ok).success).toBe(true);
    expect(accountInputSchema.safeParse({ ...ok, id: '../x' }).success).toBe(false);
    expect(accountInputSchema.safeParse({ ...ok, color: 'red' }).success).toBe(false);
  });

  it('agent messages are limited to 4,000 characters', () => {
    expect(sendToSchema.safeParse({ peer: 'a', message: 'x'.repeat(4000) }).success).toBe(true);
    expect(sendToSchema.safeParse({ peer: 'a', message: 'x'.repeat(4001) }).success).toBe(false);
    expect(sendToSchema.safeParse({ peer: 'a', message: '   ' }).success).toBe(false);
  });
});
