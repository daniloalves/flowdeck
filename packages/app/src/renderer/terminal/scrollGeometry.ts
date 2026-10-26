import type { ScrollState } from '@flowdeck/shared';

const MIN_THUMB = 24;

/** Thumb position of scrollback `state` in a track of `height` pixels. */
export function thumbGeometry(state: ScrollState, height: number): { top: number; size: number } {
  const total = state.history + state.rows;
  const size = Math.min(height, Math.max(MIN_THUMB, (state.rows / total) * height));
  const top = ((state.history - state.position) / Math.max(state.history, 1)) * (height - size);
  return { top, size };
}

/** Scrollback lines for a thumb whose top is at `top` pixels. */
export function linesAt(state: ScrollState, height: number, top: number, size: number): number {
  const free = height - size;
  const fraction = free > 0 ? Math.min(Math.max(top / free, 0), 1) : 1;
  return Math.round(state.history * (1 - fraction));
}
