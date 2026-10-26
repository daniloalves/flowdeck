import { ANNOTATION_FONT_SIZES, type Annotation, type AnnotationKind, type NodeLayout } from '@flowdeck/shared';
import { call } from '../api';
import { useStore } from '../store/store';

/** Colours offered for groups and texts. */
export const DRAW_COLORS = ['#7c6cf2', '#5b8cff', '#3ecf72', '#ff9a3c', '#ff4d5e', '#e6e6ef'] as const;
export const FONT_SIZE_LABEL: Record<(typeof ANNOTATION_FONT_SIZES)[number], string> = { 14: 'S', 20: 'M', 32: 'L', 48: 'XL' };

/** Size used when a tool is clicked instead of dragged. */
export const DEFAULT_SIZE: Record<AnnotationKind, { w: number; h: number }> = {
  group: { w: 640, h: 420 },
  text: { w: 280, h: 40 },
};

const GROUP_PADDING = 32;
const GROUP_HEADER = 36;

const reportError = (err: unknown) => useStore.getState().toast('error', (err as Error).message);

/** Creates a group or a text, selects it and opens it for editing (title or content). */
export async function createAnnotation(kind: AnnotationKind, rect: NodeLayout): Promise<Annotation | null> {
  const st = useStore.getState();
  try {
    const a = await call('annotation:create', {
      kind,
      text: '',
      color: kind === 'group' ? DRAW_COLORS[0] : DRAW_COLORS[5],
      x: rect.x,
      y: rect.y,
      w: Math.max(rect.w, kind === 'group' ? 120 : 80),
      h: Math.max(rect.h, kind === 'group' ? 80 : 24),
    });
    st.upsertAnnotation(a);
    st.selectOnly(a.id);
    st.setEditingAnnotation(a.id);
    return a;
  } catch (err) {
    reportError(err);
    return null;
  }
}

/** Wraps the selected terminals in a new group. Returns false when no terminal is selected. */
export function groupSelection(): boolean {
  const st = useStore.getState();
  const nodes = Object.entries(st.selected)
    .filter(([id, on]) => on && st.nodes[id])
    .map(([id]) => st.nodes[id]!);
  if (nodes.length === 0) return false;
  const left = Math.min(...nodes.map((n) => n.x)) - GROUP_PADDING;
  const top = Math.min(...nodes.map((n) => n.y)) - GROUP_PADDING - GROUP_HEADER;
  const right = Math.max(...nodes.map((n) => n.x + n.w)) + GROUP_PADDING;
  const bottom = Math.max(...nodes.map((n) => n.y + n.h)) + GROUP_PADDING;
  void createAnnotation('group', { x: left, y: top, w: right - left, h: bottom - top });
  return true;
}

/** Saves an annotation change; the store is updated first so the canvas does not wait. */
export function saveAnnotation(id: string, patch: Partial<Pick<Annotation, 'text' | 'color' | 'fontSize'> & NodeLayout>): void {
  const st = useStore.getState();
  st.patchAnnotation(id, patch);
  call('annotation:update', id, patch)
    .then((a) => useStore.getState().upsertAnnotation(a))
    .catch(reportError);
}

export function deleteAnnotation(id: string): void {
  call('annotation:delete', id)
    .then(() => useStore.getState().removeAnnotation(id))
    .catch(reportError);
}
