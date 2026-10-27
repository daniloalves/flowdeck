import { describe, expect, it } from 'vitest';
import { LIMITS } from '@flowdeck/shared';
import { copiedText, memoryClipboard, preparePaste } from '../../src/main/clipboard';
import { memoryLinks, rateLimited, webUrl } from '../../src/main/links';
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

describe('copying from a terminal', () => {
  it('drops the one line break a drag past the end of the line adds, nothing else', () => {
    expect(copiedText('LINE8\n')).toBe('LINE8');
    expect(copiedText('a\r\nb\r\n')).toBe('a\r\nb');
    expect(copiedText('a\n\n')).toBe('a\n');
    expect(copiedText('  indented  ')).toBe('  indented  ');
  });
});

describe('opening links from a terminal', () => {
  it('opens only plain web links', () => {
    expect(webUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(webUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'vscode://file/x',
      'ssh://host',
      'mailto:a@b.c',
      'https://bank.example@evil.example/', // credentials hide the real host
      'https://user:pw@example.com/',
      'https://example.com/a b',
      'https://example.com/\u001b]0;x',
      'example.com',
      `https://example.com/${'x'.repeat(LIMITS.linkChars)}`,
    ]) {
      expect(webUrl(bad), bad).toBeNull();
    }
  });

  it('opens at most one link per interval', async () => {
    const memory = memoryLinks();
    let t = 1000;
    const opener = rateLimited(memory, 500, () => t);
    await opener.open('https://a.example/');
    await opener.open('https://b.example/'); // same instant: dropped
    t += 500;
    await opener.open('https://c.example/');
    expect(memory.opened).toEqual(['https://a.example/', 'https://c.example/']);
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
