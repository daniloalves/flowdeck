import { describe, expect, it } from 'vitest';
import { LIMITS } from '@flowdeck/shared';
import { memoryClipboard, preparePaste } from '../../src/main/clipboard';
import { parseOsc52 } from '../../src/renderer/terminal/osc52';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('paste into a terminal', () => {
  it('turns line breaks into CR and brackets the text when the program asked for it', () => {
    expect(preparePaste('ls\nwhoami\r\n', false)).toBe('ls\rwhoami\r');
    expect(preparePaste('a\nb', true)).toBe('\x1b[200~a\rb\x1b[201~');
  });

  it('cannot break out of bracketed paste (the rest would run as typed input)', () => {
    const attack = 'harmless\x1b[201~rm -rf ~\n';
    const out = preparePaste(attack, true);
    expect(out).toBe('\x1b[200~harmlessrm -rf ~\r\x1b[201~');
    // nested markers that only form after one removal are removed too
    const nested = preparePaste('x\x1b[20\x1b[201~1~y', true);
    expect(nested.slice(6, -6)).not.toContain('\x1b[201~');
  });

  it('is capped', () => {
    expect(preparePaste('x'.repeat(LIMITS.clipboardChars + 10), false)).toHaveLength(LIMITS.clipboardChars);
  });

  it('the test clipboard keeps PRIMARY and CLIPBOARD apart', async () => {
    const c = memoryClipboard();
    await c.writeText('sel', 'selection');
    expect(await c.readText('selection')).toBe('sel');
    expect(await c.readText('clipboard')).toBe('');
  });
});

describe('OSC 52 from tmux', () => {
  it('decodes UTF-8 text for any target', () => {
    expect(parseOsc52(`c;${b64('LINE8')}`)).toBe('LINE8');
    expect(parseOsc52(`;${b64('olá 👋')}`)).toBe('olá 👋');
  });

  it('never answers a query and ignores malformed or oversized payloads', () => {
    expect(parseOsc52('c;?')).toBeNull();
    expect(parseOsc52('c;')).toBeNull();
    expect(parseOsc52(b64('no separator'))).toBeNull();
    expect(parseOsc52('c;not base64!')).toBeNull();
    expect(parseOsc52(`c;${Buffer.from([0xff, 0xfe]).toString('base64')}`)).toBeNull(); // invalid UTF-8
    expect(parseOsc52(`c;${b64('x'.repeat(LIMITS.clipboardChars + 1))}`)).toBeNull();
  });
});
