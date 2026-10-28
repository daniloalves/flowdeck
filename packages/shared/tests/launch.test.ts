import { describe, expect, it } from 'vitest';
import {
  acceleratorFromKey,
  composeTask,
  formatAccelerator,
  inside,
  isAccelerator,
  placeInGroup,
  quickLaunchSchema,
  settingsPatchSchema,
  spotNear,
  uniqueTitle,
} from '../src';

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  code,
  ...mods,
});

describe('launch helpers', () => {
  it('composes a template task around the selected or typed text', () => {
    expect(composeTask('', '  the error  ')).toBe('the error');
    expect(composeTask('Fix this:\n\n{{selection}}\n\nThanks', 'the error')).toBe('Fix this:\n\nthe error\n\nThanks');
    expect(composeTask('Compare {{selection}} with {{selection}}', 'A')).toBe('Compare A with A');
    expect(composeTask('Review the README', 'focus on install')).toBe('Review the README\n\nfocus on install');
    expect(composeTask('Review the README', '   ')).toBe('Review the README');
    expect(composeTask('Explain:\n{{selection}}', '')).toBe('Explain:');
  });

  it('unique titles add #n', () => {
    expect(uniqueTitle('api', new Set())).toBe('api');
    expect(uniqueTitle('api', new Set(['api', 'api #2']))).toBe('api #3');
    expect(uniqueTitle('api #2', new Set(['api #2']))).toBe('api #3');
  });

  it('accepts only shortcuts with Ctrl, Alt or Super, in canonical order', () => {
    for (const ok of ['', 'Control+Alt+F', 'Alt+Space', 'Super+F12', 'Control+Shift+Super+1']) expect(isAccelerator(ok)).toBe(true);
    for (const bad of ['F', 'Shift+F', 'Alt+Control+F', 'Control+Control+F', 'Control+Alt+f', 'Control+Alt+Tab', 'Control+', 'Hyper+F', 'Control+Alt+F25']) {
      expect(isAccelerator(bad)).toBe(false);
    }
    expect(settingsPatchSchema.safeParse({ quickLaunch: { shortcut: 'Shift+F' } }).success).toBe(false);
  });

  it('turns a key press into an accelerator and shows it', () => {
    expect(acceleratorFromKey(key('KeyF', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+F');
    expect(acceleratorFromKey(key('Digit3', { metaKey: true, shiftKey: true }))).toBe('Shift+Super+3');
    expect(acceleratorFromKey(key('Space', { altKey: true }))).toBe('Alt+Space');
    expect(acceleratorFromKey(key('KeyF', { shiftKey: true }))).toBeNull();
    expect(acceleratorFromKey(key('Tab', { ctrlKey: true }))).toBeNull();
    expect(formatAccelerator('Control+Alt+F')).toBe('Ctrl+Alt+F');
    expect(formatAccelerator('')).toBe('Off');
  });

  it('quick launches take an optional title and group', () => {
    expect(quickLaunchSchema.parse({ templateId: 't1' })).toEqual({ templateId: 't1', title: '', text: '', groupId: null });
    expect(quickLaunchSchema.safeParse({ templateId: 't1', title: 'a\x1bb' }).success).toBe(false);
    expect(quickLaunchSchema.safeParse({ templateId: '../x' }).success).toBe(false);
  });
});

describe('placement', () => {
  const size = { w: 200, h: 100 };

  it('steps aside from a node already at the centre', () => {
    expect(spotNear({ x: 500, y: 500 }, size, [])).toEqual({ x: 400, y: 450 });
    expect(spotNear({ x: 500, y: 500 }, size, [{ x: 400, y: 450, w: 200, h: 100 }])).toEqual({ x: 440, y: 490 });
  });

  it('puts a node in the first free spot inside a group, next to what is there', () => {
    const group = { x: 0, y: 0, w: 1000, h: 600 };
    const first = placeInGroup(group, size, []);
    expect(first).toEqual({ x: 32, y: 68, group });
    const taken = { x: 32, y: 68, w: 200, h: 100 };
    const second = placeInGroup(group, size, [taken, { x: 5000, y: 5000, w: 200, h: 100 }]);
    expect(second).toEqual({ x: 272, y: 68, group });
    expect(inside({ ...second, ...size }, group)).toBe(true);
  });

  it('grows a full group downwards (and wider for a wide node) so the node lies inside it', () => {
    const group = { x: 100, y: 100, w: 300, h: 250 };
    const member = { x: 132, y: 168, w: 200, h: 100 };
    const spot = placeInGroup(group, size, [member]);
    expect(spot).toMatchObject({ x: 132, y: 308 });
    expect(spot.group).toEqual({ x: 100, y: 100, w: 300, h: 340 });
    expect(inside({ x: spot.x, y: spot.y, ...size }, spot.group)).toBe(true);
    expect(inside(member, spot.group)).toBe(true);

    const wide = placeInGroup(group, { w: 720, h: 440 }, []);
    expect(wide.group.w).toBe(720 + 64);
    expect(inside({ x: wide.x, y: wide.y, w: 720, h: 440 }, wide.group)).toBe(true);
  });
});
