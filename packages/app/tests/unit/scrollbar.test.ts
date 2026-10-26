import { describe, expect, it } from 'vitest';
import { linesAt, thumbGeometry } from '../../src/renderer/terminal/scrollGeometry';

const state = { inMode: true, position: 0, history: 300, rows: 30 };

describe('terminal scrollbar geometry', () => {
  it('puts the thumb at the bottom when live, at the top when fully scrolled back', () => {
    const live = thumbGeometry(state, 330);
    expect(live.size).toBeCloseTo(30);
    expect(live.top).toBeCloseTo(300);
    expect(thumbGeometry({ ...state, position: 300 }, 330).top).toBe(0);
  });

  it('keeps a grabbable minimum size for long histories', () => {
    expect(thumbGeometry({ ...state, history: 50_000 }, 300).size).toBe(24);
  });

  it('maps a thumb position back to lines (inverse of thumbGeometry), clamped', () => {
    for (const position of [0, 1, 150, 299, 300]) {
      const g = thumbGeometry({ ...state, position }, 330);
      expect(linesAt(state, 330, g.top, g.size)).toBe(position);
    }
    expect(linesAt(state, 330, -50, 30)).toBe(300);
    expect(linesAt(state, 330, 9999, 30)).toBe(0);
  });
});
