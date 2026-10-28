import { describe, expect, it } from 'vitest';
import { LIMITS } from '@flowdeck/shared';
import { memoryClipboard } from '../../src/main/clipboard';
import { memoryShortcuts, normalizeSelection, readSelection, systemShortcuts, wantsQuickLaunch } from '../../src/main/quick/selection';

describe('quick launch selection', () => {
  it('normalises selected text: LF line breaks, no control characters, trimmed', () => {
    expect(normalizeSelection('  a\r\nb\rc\x1b[31m\x00d\te  ')).toEqual({ text: 'a\nb\nc[31md\te', truncated: false });
    const long = normalizeSelection('x'.repeat(LIMITS.selectionChars + 5));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(LIMITS.selectionChars);
  });

  it('reads the selection, else the clipboard, else nothing', async () => {
    const clip = memoryClipboard();
    expect(await readSelection(clip)).toEqual({ text: '', source: 'none', truncated: false });
    clip.contents.clipboard = 'copied';
    expect(await readSelection(clip)).toMatchObject({ text: 'copied', source: 'clipboard' });
    clip.contents.selection = '  selected \n';
    expect(await readSelection(clip)).toMatchObject({ text: 'selected', source: 'selection' });
    clip.contents.selection = '\x1b\x07 ';
    expect(await readSelection(clip)).toMatchObject({ text: 'copied', source: 'clipboard' });
  });

  it('--quick-launch on the command line', () => {
    expect(wantsQuickLaunch(['/usr/bin/flowdeck', '--quick-launch'])).toBe(true);
    expect(wantsQuickLaunch(['/usr/bin/flowdeck', '--no-sandbox'])).toBe(false);
  });

  it('test shortcuts never grab keys; Electron errors become "not registered"', () => {
    const mem = memoryShortcuts();
    let pressed = 0;
    mem.register('Control+Alt+F', () => pressed++);
    expect(mem.press('Control+Alt+F')).toBe(true);
    mem.unregister('Control+Alt+F');
    expect(mem.press('Control+Alt+F')).toBe(false);
    expect(pressed).toBe(1);
    const throwing = systemShortcuts({
      register: () => {
        throw new Error('invalid');
      },
      unregister: () => undefined,
    });
    expect(throwing.register('Control+Alt+F', () => undefined)).toBe(false);
  });
});
