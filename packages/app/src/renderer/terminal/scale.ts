import type { Terminal } from '@xterm/xterm';

type Point = { clientX: number; clientY: number };

interface MouseServiceLike {
  getCoords(event: Point, element: HTMLElement, ...rest: unknown[]): [number, number] | undefined;
  getMouseReportCoords(event: Point, element: HTMLElement): unknown;
}

/**
 * Maps a pointer position into the element's own (unscaled) CSS pixels. The canvas zoom is a CSS
 * `scale()`: `getBoundingClientRect` is scaled, `offsetWidth` is not.
 */
export function unscalePoint(event: Point, element: HTMLElement): Point {
  const rect = element.getBoundingClientRect();
  const scale = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-3) return event;
  return {
    clientX: rect.left + (event.clientX - rect.left) / scale,
    clientY: rect.top + (event.clientY - rect.top) / scale,
  };
}

const isMouseService = (v: unknown): v is MouseServiceLike =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as MouseServiceLike).getCoords === 'function' &&
  typeof (v as MouseServiceLike).getMouseReportCoords === 'function';

/**
 * xterm.js turns pointer positions into cells with unscaled cell sizes but scaled element bounds,
 * so on a zoomed canvas the wrong row/column is selected or reported to tmux. This wraps xterm's
 * (private) mouse service to unscale the pointer first. Returns false, changing nothing, if the
 * internals no longer have the expected shape (covered by an E2E test).
 */
export function fixMouseScaling(term: Terminal): boolean {
  const core = (term as unknown as { _core?: { _mouseService?: unknown } })._core;
  const service = core?._mouseService;
  if (!isMouseService(service)) return false;
  const getCoords = service.getCoords.bind(service);
  const getReport = service.getMouseReportCoords.bind(service);
  service.getCoords = (event, element, ...rest) => getCoords(unscalePoint(event, element), element, ...rest);
  service.getMouseReportCoords = (event, element) => getReport(unscalePoint(event, element), element);
  return true;
}
