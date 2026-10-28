import { LIMITS } from './constants';

/* ---------- titles and tasks ---------- */

export const folderName = (cwd: string): string => cwd.split('/').filter(Boolean).pop() ?? cwd;

/** `base`, or `base #n` when a node already has that title (peers are addressed by title). */
export function uniqueTitle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const stem = base.replace(/ #\d+$/, '').slice(0, LIMITS.titleChars - 6);
  let n = 2;
  while (taken.has(`${stem} #${n}`)) n++;
  return `${stem} #${n}`;
}

/** Marks where a template's task takes the selected (or typed) text. */
export const SELECTION_PLACEHOLDER = '{{selection}}';

/**
 * The task a template launches with: its own task text with `{{selection}}` replaced by `text`, or
 * `text` added after a blank line when there is no placeholder. No template text: `text` alone.
 */
export function composeTask(templateTask: string, text: string): string {
  const own = templateTask.trim();
  if (!own) return text.trim();
  if (own.includes(SELECTION_PLACEHOLDER)) return own.split(SELECTION_PLACEHOLDER).join(text.trim()).trim();
  return text.trim() ? `${own}\n\n${text.trim()}` : own;
}

/* ---------- keyboard shortcuts (Electron accelerators) ---------- */

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'] as const;
const MAIN_MODIFIERS = new Set<string>(['Control', 'Alt', 'Super']);
const ACCELERATOR_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space)$/;

/**
 * A global shortcut FlowDeck accepts: modifiers in canonical order, at least one of Ctrl, Alt or
 * Super (a bare key or Shift+key would steal typing from every app), then a letter, digit, F-key or
 * Space. '' means off.
 */
export function isAccelerator(s: string): boolean {
  if (s === '') return true;
  const parts = s.split('+');
  const key = parts.pop() ?? '';
  if (!ACCELERATOR_KEY.test(key) || parts.length === 0) return false;
  let last = -1;
  for (const p of parts) {
    const i = MODIFIERS.indexOf(p as (typeof MODIFIERS)[number]);
    if (i <= last) return false; // unknown, repeated or out of order
    last = i;
  }
  return parts.some((p) => MAIN_MODIFIERS.has(p));
}

/** The accelerator for a key press, or null when it cannot be a global shortcut. */
export function acceleratorFromKey(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }): string | null {
  const key = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? (/^F\d{1,2}$|^Space$/.test(e.code) ? e.code : null);
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(
    (m): m is string => Boolean(m),
  );
  const accelerator = [...mods, key].join('+');
  return isAccelerator(accelerator) ? accelerator : null;
}

/** How a shortcut is shown: "Ctrl+Alt+F", or "Off". */
export const formatAccelerator = (a: string): string => (a ? a.replace(/\bControl\b/g, 'Ctrl') : 'Off');

/* ---------- placement on the canvas ---------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Inner margins of a group: what lies fully inside its rectangle moves with it. */
export const GROUP_PADDING = 32;
export const GROUP_HEADER = 36;
const GAP = 40;

export const inside = (r: Rect, g: Rect): boolean => r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h;
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Top-left of a `size` item centred on `center`, stepping aside while another item starts at the same spot. */
export function spotNear(center: { x: number; y: number }, size: { w: number; h: number }, occupied: readonly Rect[]): { x: number; y: number } {
  let x = center.x - size.w / 2;
  let y = center.y - size.h / 2;
  while (occupied.some((r) => Math.abs(r.x - x) < 30 && Math.abs(r.y - y) < 30)) {
    x += 40;
    y += 40;
  }
  return { x, y };
}

/**
 * Where a `size` item goes inside a group: the first free spot in reading order (next to or below
 * what is already there). When none is free it goes below the group's content, and `group` is the
 * rectangle the group must grow to so the item lies fully inside it.
 */
export function placeInGroup(group: Rect, size: { w: number; h: number }, occupied: readonly Rect[]): { x: number; y: number; group: Rect } {
  const left = group.x + GROUP_PADDING;
  const top = group.y + GROUP_HEADER + GROUP_PADDING;
  const right = group.x + group.w - GROUP_PADDING;
  const bottom = group.y + group.h - GROUP_PADDING;
  const members = occupied.filter((r) => overlaps(r, group));
  const candidates = [{ x: left, y: top }];
  for (const m of members) {
    candidates.push({ x: m.x + m.w + GAP, y: m.y }, { x: left, y: m.y + m.h + GAP }, { x: m.x, y: m.y + m.h + GAP });
  }
  const free = candidates
    .filter((c) => c.x >= left && c.y >= top && c.x + size.w <= right && c.y + size.h <= bottom)
    .filter((c) => !members.some((m) => overlaps({ ...c, ...size }, m)))
    .sort((a, b) => a.y - b.y || a.x - b.x)[0];
  if (free) return { ...free, group };
  const y = Math.max(top, ...members.map((m) => m.y + m.h + GAP));
  return {
    x: left,
    y,
    group: { ...group, w: Math.max(group.w, size.w + 2 * GROUP_PADDING), h: y + size.h + GROUP_PADDING - group.y },
  };
}
