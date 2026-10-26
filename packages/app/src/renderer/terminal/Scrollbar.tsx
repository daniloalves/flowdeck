import { useRef } from 'react';
import type { ScrollState } from '@flowdeck/shared';
import { linesAt, thumbGeometry } from './scrollGeometry';

interface Props {
  state: ScrollState | null;
  /** Scrolls to `lines` above the bottom (0 = back to the live output). */
  onScrollTo: (lines: number) => void;
}

/**
 * Slim overlay scrollbar for tmux's scrollback, shown while scrolled back. The thumb can be dragged
 * and the track clicked; reaching the bottom returns to the live output.
 */
export function Scrollbar({ state, onScrollTo }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ offset: number } | null>(null);
  const visible = state !== null && state.inMode && state.history > 0;
  const height = track.current?.clientHeight ?? 0;
  const geometry = visible && height > 0 ? thumbGeometry(state, height) : null;

  /** Pointer position in the track's own pixels (the canvas zoom scales screen pixels). */
  const localY = (clientY: number): number => {
    const el = track.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const scale = el.clientHeight > 0 ? rect.height / el.clientHeight : 1;
    return (clientY - rect.top) / (scale || 1);
  };

  const scrollToPointer = (clientY: number, offset: number) => {
    if (!track.current || !state || !geometry) return;
    onScrollTo(linesAt(state, track.current.clientHeight, localY(clientY) - offset, geometry.size));
  };

  return (
    <div
      ref={track}
      className={`fd-scrollbar nodrag nowheel ${visible ? 'visible' : ''}`}
      data-testid="terminal-scrollbar"
      onPointerDown={(e) => {
        if (!geometry || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const y = localY(e.clientY);
        // On the thumb: keep the grab point. On the track: centre the thumb there.
        const onThumb = y >= geometry.top && y <= geometry.top + geometry.size;
        drag.current = { offset: onThumb ? y - geometry.top : geometry.size / 2 };
        if (!onThumb) scrollToPointer(e.clientY, drag.current.offset);
      }}
      onPointerMove={(e) => drag.current && scrollToPointer(e.clientY, drag.current.offset)}
      onPointerUp={() => (drag.current = null)}
    >
      {geometry && <div className="fd-scrollbar-thumb" style={{ top: geometry.top, height: geometry.size }} />}
    </div>
  );
}
