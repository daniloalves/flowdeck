import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import { inside, type NodeLayout } from '@flowdeck/shared';
import { call, on } from '../api';
import { useStore } from '../store/store';
import { GroupNode, TextNode, type GroupFlowNode, type TextFlowNode } from './AnnotationNodes';
import { DEFAULT_SIZE, createAnnotation, deleteAnnotation, saveAnnotation } from './drawing';
import { TerminalNode, type TerminalFlowNode } from './TerminalNode';

const nodeTypes = { terminal: TerminalNode, 'group-box': GroupNode, 'text-box': TextNode };
type FlowNode = TerminalFlowNode | GroupFlowNode | TextFlowNode;

/** Groups stay below terminals and edges, also when selected (selection adds 1000). */
const GROUP_Z = -2000;
/** Texts stay in front of terminals and edges, also selected ones (edges can be lifted to 2000). */
const TEXT_Z = 3000;

/** Items that move with a group being dragged: their start positions. */
type GroupDrag = { start: { x: number; y: number }; members: Map<string, { x: number; y: number }> };

const STATE_COLOR: Record<string, string> = {
  working: '#5b8cff',
  idle: '#3ecf72',
  needs_input: '#ff9a3c',
  dead: '#666',
  starting: '#8a8aff',
  unknown: '#888',
};

export function Canvas() {
  const order = useStore((s) => s.order);
  const nodesById = useStore((s) => s.nodes);
  const annotations = useStore((s) => s.annotations);
  const selected = useStore((s) => s.selected);
  const edges = useStore((s) => s.edges);
  const viewport = useStore((s) => s.viewport);
  const flow = useReactFlow();
  const saveTimer = useRef<number>(0);
  // React Flow re-adopts controlled nodes on every render: they must carry their measured size,
  // or it treats them as unmeasured (auto-height texts would be hidden).
  const [textSizes, setTextSizes] = useState<Record<string, { width: number; height: number }>>({});

  const nodes: FlowNode[] = useMemo(() => {
    const all = Object.values(annotations);
    const groups: GroupFlowNode[] = all
      .filter((a) => a.kind === 'group')
      .map((a) => ({
        id: a.id,
        type: 'group-box' as const,
        position: { x: a.x, y: a.y },
        width: a.w,
        height: a.h,
        measured: { width: a.w, height: a.h },
        data: { annotationId: a.id },
        dragHandle: '.fd-group-header',
        zIndex: GROUP_Z,
        selected: selected[a.id] ?? false,
      }));
    const terminals: TerminalFlowNode[] = order
      .map((id) => nodesById[id])
      .filter((n) => n !== undefined)
      .map((n) => ({
        id: n.id,
        type: 'terminal' as const,
        position: { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        measured: { width: n.w, height: n.h },
        data: { nodeId: n.id },
        dragHandle: '.fd-node-header',
        selected: selected[n.id] ?? false,
      }));
    // Texts size their height to their content.
    const texts: TextFlowNode[] = all
      .filter((a) => a.kind === 'text')
      .map((a) => ({
        id: a.id,
        type: 'text-box' as const,
        position: { x: a.x, y: a.y },
        width: a.w,
        ...(textSizes[a.id] ? { measured: textSizes[a.id] } : {}),
        data: { annotationId: a.id },
        zIndex: TEXT_Z,
        selected: selected[a.id] ?? false,
      }));
    return [...groups, ...terminals, ...texts];
  }, [order, nodesById, annotations, selected, textSizes]);

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        markerEnd: { type: MarkerType.ArrowClosed },
        ...(e.direction === 'both' ? { markerStart: { type: MarkerType.ArrowClosed } } : {}),
        className: 'fd-edge',
        data: { direction: e.direction },
      })),
    [edges],
  );

  const persistLayout = useCallback((id: string) => {
    const n = useStore.getState().nodes[id];
    if (!n) return;
    call('node:update', id, { layout: { x: n.x, y: n.y, w: n.w, h: n.h } }).catch((err: Error) =>
      useStore.getState().toast('error', err.message),
    );
  }, []);

  const groupDrags = useRef(new Map<string, GroupDrag>());

  /** Current layout of a terminal or annotation (texts use their measured height). */
  const layoutOf = useCallback(
    (id: string): NodeLayout | null => {
      const st = useStore.getState();
      const n = st.nodes[id];
      if (n) return { x: n.x, y: n.y, w: n.w, h: n.h };
      const a = st.annotations[id];
      if (!a) return null;
      return { x: a.x, y: a.y, w: a.w, h: (a.kind === 'text' ? textSizes[id]?.height : undefined) ?? a.h };
    },
    [textSizes],
  );

  const moveItem = (id: string, pos: { x: number; y: number }) => {
    const st = useStore.getState();
    if (st.nodes[id]) st.moveNode(id, pos);
    else st.patchAnnotation(id, pos);
  };

  const persistItem = useCallback(
    (id: string) => {
      const st = useStore.getState();
      if (st.nodes[id]) persistLayout(id);
      const a = st.annotations[id];
      if (a) saveAnnotation(id, { x: a.x, y: a.y, w: a.w, h: layoutOf(id)?.h ?? a.h });
    },
    [persistLayout, layoutOf],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const st = useStore.getState();
      const moving = new Set(changes.filter((c) => c.type === 'position').map((c) => c.id));
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const group = st.annotations[c.id]?.kind === 'group' ? c.id : null;
          // A dragged group carries what lies fully inside it (unless already moving with it).
          if (group && c.dragging) {
            let drag = groupDrags.current.get(group);
            if (!drag) {
              const g = layoutOf(group)!;
              const members = new Map<string, { x: number; y: number }>();
              for (const id of [...Object.keys(st.nodes), ...Object.keys(st.annotations)]) {
                const r = id === group || moving.has(id) ? null : layoutOf(id);
                if (r && inside(r, g)) members.set(id, { x: r.x, y: r.y });
              }
              drag = { start: { x: g.x, y: g.y }, members };
              groupDrags.current.set(group, drag);
            }
            const dx = c.position.x - drag.start.x;
            const dy = c.position.y - drag.start.y;
            for (const [id, p] of drag.members) moveItem(id, { x: p.x + dx, y: p.y + dy });
          }
          moveItem(c.id, { x: c.position.x, y: c.position.y });
          if (c.dragging === false) {
            persistItem(c.id);
            const drag = group ? groupDrags.current.get(group) : undefined;
            if (group) groupDrags.current.delete(group);
            for (const id of drag?.members.keys() ?? []) persistItem(id);
          }
        } else if (c.type === 'dimensions' && c.dimensions) {
          const size = c.dimensions;
          if (st.annotations[c.id]?.kind === 'text') {
            setTextSizes((prev) => {
              const old = prev[c.id];
              return old && old.width === size.width && old.height === size.height ? prev : { ...prev, [c.id]: size };
            });
          }
          if (c.resizing === undefined) continue; // a measurement, not a user resize
          if (st.nodes[c.id]) st.moveNode(c.id, { w: size.width, h: size.height });
          else st.patchAnnotation(c.id, { w: size.width, h: size.height });
          if (c.resizing === false) persistItem(c.id);
        } else if (c.type === 'select') {
          st.select(c.id, c.selected);
        } else if (c.type === 'remove' && st.annotations[c.id]) {
          deleteAnnotation(c.id);
        }
      }
    },
    [layoutOf, persistItem],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === 'remove') {
        call('edge:delete', c.id)
          .then(() => useStore.getState().removeEdge(c.id))
          .catch((err: Error) => useStore.getState().toast('error', err.message));
      }
    }
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    const direction = useStore.getState().newEdgeDirection;
    call('edge:create', { source: conn.source, target: conn.target, direction })
      .then((e) => useStore.getState().addEdge(e))
      .catch((err: Error) => useStore.getState().toast('error', err.message));
  }, []);

  const onMoveEnd = useCallback((_e: unknown, v: Viewport) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void call('viewport:save', v).catch(() => undefined), 400);
  }, []);

  useEffect(
    () =>
      on('ui:focusNode', ({ nodeId }) => {
        const n = useStore.getState().nodes[nodeId];
        if (n) void flow.setCenter(n.x + n.w / 2, n.y + n.h / 2, { zoom: 1, duration: 300 });
      }),
    [flow],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onMoveEnd={onMoveEnd}
      // The keyboard deletes edges, groups and texts; closing a terminal kills its process.
      onBeforeDelete={async ({ nodes: delNodes, edges: del }) => ({
        nodes: delNodes.filter((n) => n.type !== 'terminal'),
        edges: del,
      })}
      deleteKeyCode={['Backspace', 'Delete']}
      defaultViewport={viewport ?? { x: 0, y: 0, zoom: 0.8 }}
      minZoom={0.1}
      maxZoom={2}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      selectionOnDrag={false}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => {
          const st = useStore.getState();
          const a = st.annotations[n.id];
          if (a) return a.kind === 'group' ? `${a.color}33` : 'transparent';
          return STATE_COLOR[st.nodes[n.id]?.status.state ?? 'unknown'] ?? '#888';
        }}
      />
      <DrawLayer />
    </ReactFlow>
  );
}

/**
 * While a drawing tool is active, a transparent layer over the canvas turns a drag into a group or
 * text of that size (a click uses a default size). Esc cancels (handled in App).
 */
function DrawLayer() {
  const mode = useStore((s) => s.drawMode);
  const flow = useReactFlow();
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  if (!mode) return null;

  const local = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!from) return;
    const r = e.currentTarget.getBoundingClientRect();
    const end = local(e);
    setFrom(null);
    setTo(null);
    useStore.getState().setDrawMode(null);
    const a = flow.screenToFlowPosition({ x: r.left + Math.min(from.x, end.x), y: r.top + Math.min(from.y, end.y) });
    const b = flow.screenToFlowPosition({ x: r.left + Math.max(from.x, end.x), y: r.top + Math.max(from.y, end.y) });
    const dragged = Math.abs(end.x - from.x) > 8 && Math.abs(end.y - from.y) > 8;
    const size = dragged ? { w: b.x - a.x, h: b.y - a.y } : DEFAULT_SIZE[mode];
    void createAnnotation(mode, { x: a.x, y: a.y, ...size });
  };

  const box =
    from && to
      ? { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }
      : null;

  return (
    <div
      className="fd-draw-layer"
      data-testid="draw-layer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setFrom(local(e));
        setTo(local(e));
      }}
      onPointerMove={(e) => from && setTo(local(e))}
      onPointerUp={finish}
    >
      <span className="fd-draw-hint">
        {mode === 'group' ? 'Drag to draw a group' : 'Click or drag where the text goes'} — Esc cancels
      </span>
      {box && <div className={`fd-draw-preview fd-draw-preview-${mode}`} style={box} />}
    </div>
  );
}
