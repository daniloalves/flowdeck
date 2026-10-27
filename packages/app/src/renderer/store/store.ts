import { create } from 'zustand';
import type {
  NodeKind,
  Account,
  Annotation,
  AccountUsage,
  AppSnapshot,
  Edge,
  EdgeDirection,
  Environment,
  Message,
  NodeTemplate,
  NodeView,
  Viewport,
} from '@flowdeck/shared';

export type Panel = 'none' | 'accounts' | 'messages' | 'terminals' | 'launch';

/** What the template editor opens with: a saved template (with its id) or settings to start from. */
export type TemplateDraft = Partial<Omit<NodeTemplate, 'createdAt'>>;

/** What the "New node" dialog opens with. */
export interface DialogState {
  kind?: NodeKind;
  account?: string | null;
  title?: string;
}

/** Canvas drawing tool waiting for a drag (null: normal canvas). */
export type DrawMode = 'group' | 'text' | null;

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

interface State {
  loaded: boolean;
  nodes: Record<string, NodeView>;
  order: string[];
  selected: Record<string, boolean>;
  edges: Edge[];
  annotations: Record<string, Annotation>;
  /** Node templates, by name. */
  templates: NodeTemplate[];
  templateDialog: TemplateDraft | null;
  drawMode: DrawMode;
  /** Group or text whose title/content is being edited. */
  editingAnnotation: string | null;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  messages: Message[];
  env: Environment | null;
  viewport: Viewport | null;
  /** Incremented to force a terminal to re-attach (after restart). */
  attachGen: Record<string, number>;
  newEdgeDirection: EdgeDirection;
  panel: Panel;
  dialog: DialogState | null;
  toasts: Toast[];

  load(s: AppSnapshot): void;
  upsertNode(n: NodeView): void;
  /** Layout changes from the canvas (not yet persisted). */
  moveNode(id: string, patch: Partial<Pick<NodeView, 'x' | 'y' | 'w' | 'h'>>): void;
  removeNode(id: string): void;
  select(id: string, selected: boolean): void;
  /** Selects one node and clears the rest. */
  selectOnly(id: string): void;
  upsertAnnotation(a: Annotation): void;
  /** Local changes from the canvas (not yet persisted). */
  patchAnnotation(id: string, patch: Partial<Omit<Annotation, 'id' | 'kind'>>): void;
  removeAnnotation(id: string): void;
  upsertTemplate(t: NodeTemplate): void;
  removeTemplate(id: string): void;
  openTemplateDialog(d: TemplateDraft): void;
  closeTemplateDialog(): void;
  setDrawMode(mode: DrawMode): void;
  setEditingAnnotation(id: string | null): void;
  addEdge(e: Edge): void;
  removeEdge(id: string): void;
  setAccounts(a: Account[]): void;
  setUsage(u: AccountUsage[]): void;
  setMessages(m: Message[]): void;
  upsertMessage(m: Message): void;
  bumpAttach(id: string): void;
  setEnv(patch: Partial<Environment>): void;
  setNewEdgeDirection(d: EdgeDirection): void;
  setPanel(p: Panel): void;
  openDialog(d: DialogState): void;
  closeDialog(): void;
  toast(kind: Toast['kind'], text: string): void;
  dismiss(id: number): void;
}

let toastId = 0;

export const useStore = create<State>((set) => ({
  loaded: false,
  nodes: {},
  order: [],
  selected: {},
  edges: [],
  annotations: {},
  templates: [],
  templateDialog: null,
  drawMode: null,
  editingAnnotation: null,
  accounts: [],
  usage: {},
  messages: [],
  env: null,
  viewport: null,
  attachGen: {},
  newEdgeDirection: 'both',
  panel: 'none',
  dialog: null,
  toasts: [],

  load: (s) =>
    set({
      loaded: true,
      nodes: Object.fromEntries(s.nodes.map((n) => [n.id, n])),
      order: s.nodes.map((n) => n.id),
      edges: s.edges,
      annotations: Object.fromEntries(s.annotations.map((a) => [a.id, a])),
      templates: s.templates,
      accounts: s.accounts,
      usage: Object.fromEntries(s.usage.map((u) => [u.accountId, u])),
      env: s.env,
      viewport: s.viewport,
    }),

  upsertNode: (n) =>
    set((st) => {
      const prev = st.nodes[n.id];
      // Keep the local layout while the user may be dragging; main only echoes what we sent.
      const merged = prev ? { ...n, x: prev.x, y: prev.y, w: prev.w, h: prev.h } : n;
      return {
        nodes: { ...st.nodes, [n.id]: merged },
        order: prev ? st.order : [...st.order, n.id],
      };
    }),

  moveNode: (id, patch) =>
    set((st) => {
      const prev = st.nodes[id];
      return prev ? { nodes: { ...st.nodes, [id]: { ...prev, ...patch } } } : {};
    }),

  removeNode: (id) =>
    set((st) => {
      const { [id]: _removed, ...nodes } = st.nodes;
      const { [id]: _sel, ...selected } = st.selected;
      return {
        nodes,
        selected,
        order: st.order.filter((x) => x !== id),
        edges: st.edges.filter((e) => e.source !== id && e.target !== id),
      };
    }),

  select: (id, selected) => set((st) => ({ selected: { ...st.selected, [id]: selected } })),
  selectOnly: (id) => set({ selected: { [id]: true } }),
  upsertAnnotation: (a) => set((st) => ({ annotations: { ...st.annotations, [a.id]: a } })),
  patchAnnotation: (id, patch) =>
    set((st) => {
      const prev = st.annotations[id];
      return prev ? { annotations: { ...st.annotations, [id]: { ...prev, ...patch } } } : {};
    }),
  removeAnnotation: (id) =>
    set((st) => {
      const { [id]: _removed, ...annotations } = st.annotations;
      const { [id]: _sel, ...selected } = st.selected;
      return { annotations, selected, editingAnnotation: st.editingAnnotation === id ? null : st.editingAnnotation };
    }),
  upsertTemplate: (t) =>
    set((st) => ({
      templates: [...st.templates.filter((x) => x.id !== t.id), t].sort(
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt,
      ),
    })),
  removeTemplate: (id) => set((st) => ({ templates: st.templates.filter((t) => t.id !== id) })),
  openTemplateDialog: (templateDialog) => set({ templateDialog }),
  closeTemplateDialog: () => set({ templateDialog: null }),
  setDrawMode: (drawMode) => set({ drawMode }),
  setEditingAnnotation: (editingAnnotation) => set({ editingAnnotation }),
  addEdge: (e) => set((st) => ({ edges: [...st.edges.filter((x) => x.id !== e.id), e] })),
  removeEdge: (id) => set((st) => ({ edges: st.edges.filter((e) => e.id !== id) })),
  setAccounts: (accounts) => set({ accounts }),
  setUsage: (u) => set({ usage: Object.fromEntries(u.map((x) => [x.accountId, x])) }),
  setMessages: (messages) => set({ messages }),
  upsertMessage: (m) =>
    set((st) => {
      const idx = st.messages.findIndex((x) => x.id === m.id);
      if (idx === -1) return { messages: [m, ...st.messages].slice(0, 500) };
      const messages = [...st.messages];
      messages[idx] = m;
      return { messages };
    }),
  bumpAttach: (id) => set((st) => ({ attachGen: { ...st.attachGen, [id]: (st.attachGen[id] ?? 0) + 1 } })),
  setEnv: (patch) => set((st) => (st.env ? { env: { ...st.env, ...patch } } : {})),
  setNewEdgeDirection: (newEdgeDirection) => set({ newEdgeDirection }),
  setPanel: (panel) => set({ panel }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  toast: (kind, text) => {
    const id = ++toastId;
    set((st) => ({ toasts: [...st.toasts, { id, kind, text }] }));
    setTimeout(() => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
};
