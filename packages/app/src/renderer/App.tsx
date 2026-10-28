import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AGENT_KINDS, AGENT_LABEL } from '@flowdeck/shared';
import { call, on } from './api';
import { Canvas } from './canvas/Canvas';
import { groupSelection } from './canvas/drawing';
import { AccountsPanel } from './panels/AccountsPanel';
import { LaunchPanel } from './panels/LaunchPanel';
import { MessagesPanel } from './panels/MessagesPanel';
import { NewNodeDialog } from './panels/NewNodeDialog';
import { TemplateDialog } from './panels/TemplateDialog';
import { TerminalsPanel } from './panels/TerminalsPanel';
import { Bullet } from './status/legend';
import { useStore, type Panel } from './store/store';

type AppShortcut = 'new' | 'duplicate' | 'group' | 'text' | 'launch';
const SHORTCUT_KEYS: Record<string, AppShortcut> = { n: 'new', d: 'duplicate', g: 'group', x: 'text', l: 'launch' };

/** Global shortcuts (Ctrl+Shift+key). xterm is told to ignore them (see terminal/Terminal.tsx). */
export const isAppShortcut = (e: KeyboardEvent): AppShortcut | null => {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  return SHORTCUT_KEYS[e.key.toLowerCase()] ?? null;
};

/** Group tool: wraps the selected terminals at once, otherwise waits for a drag on the canvas. */
function startGroup(): void {
  if (!groupSelection()) useStore.getState().setDrawMode('group');
}

function useMainEvents(): void {
  useEffect(() => {
    const st = useStore.getState;
    const offs = [
      on('node:changed', (n) => st().upsertNode(n)),
      on('node:removed', ({ id }) => st().removeNode(id)),
      on('edge:removed', ({ id }) => st().removeEdge(id)),
      on('usage:changed', (u) => st().setUsage(u)),
      on('message:added', (m) => st().upsertMessage(m)),
      on('message:changed', (m) => st().upsertMessage(m)),
      on('annotation:changed', (a) => st().upsertAnnotation(a)),
    ];
    call('app:snapshot')
      .then((s) => st().load(s))
      .catch((err: Error) => st().toast('error', err.message));
    return () => offs.forEach((off) => off());
  }, []);
}

/** Duplicates the selected node (one selected), placing the copy to its right. */
async function duplicateSelected(): Promise<void> {
  const st = useStore.getState();
  const selected = Object.entries(st.selected)
    .filter(([id, on]) => on && st.nodes[id])
    .map(([id]) => id);
  if (selected.length !== 1) {
    st.toast('info', 'Select one node to duplicate (click its header).');
    return;
  }
  try {
    st.upsertNode(await call('node:duplicate', selected[0]!));
  } catch (err) {
    st.toast('error', (err as Error).message);
  }
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.key === 'Escape' && st.drawMode) {
        e.preventDefault();
        st.setDrawMode(null);
        return;
      }
      const action = isAppShortcut(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return; // holding the keys must not spawn a node per auto-repeat
      if (action === 'new') {
        if (!st.dialog) st.openDialog({});
      } else if (action === 'duplicate') void duplicateSelected();
      else if (action === 'group') startGroup();
      else if (action === 'launch') st.setPanel(st.panel === 'launch' ? 'none' : 'launch');
      else st.setDrawMode('text');
    };
    // Capture phase: runs before xterm or React Flow see the key.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function TabButton({ id, label, testId }: { id: Exclude<Panel, 'none'>; label: React.ReactNode; testId: string }) {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <button className={`fd-btn ${panel === id ? 'active' : ''}`} onClick={() => setPanel(panel === id ? 'none' : id)} data-testid={testId}>
      {label}
    </button>
  );
}

/** "Terminals" tab label with the number of nodes that need attention or are working. */
function TerminalsTabLabel() {
  const counts = useStore((s) => {
    let needs = 0;
    let working = 0;
    for (const n of Object.values(s.nodes)) {
      if (n.status.state === 'needs_input') needs++;
      else if (n.status.state === 'working') working++;
    }
    return `${needs}:${working}`;
  });
  const [needs, working] = counts.split(':').map(Number) as [number, number];
  return (
    <span className="fd-tab-label">
      Terminals
      {needs > 0 && (
        <span className="fd-tab-count" title={`${needs} need you`}>
          <Bullet state="needs_input" />
          {needs}
        </span>
      )}
      {working > 0 && (
        <span className="fd-tab-count" title={`${working} working`}>
          <Bullet state="working" />
          {working}
        </span>
      )}
    </span>
  );
}

function Toolbar() {
  const env = useStore((s) => s.env);
  const direction = useStore((s) => s.newEdgeDirection);
  const setDirection = useStore((s) => s.setNewEdgeDirection);
  const setEnv = useStore((s) => s.setEnv);
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const drawMode = useStore((s) => s.drawMode);
  const setDrawMode = useStore((s) => s.setDrawMode);
  const flow = useReactFlow();
  const missing = env ? AGENT_KINDS.filter((k) => !env.agents[k]) : [];

  // fitBounds rather than fitView: fitView waits for a node update that may never come.
  const fitAll = () => {
    const nodes = flow.getNodes();
    if (nodes.length > 0) void flow.fitBounds(flow.getNodesBounds(nodes), { duration: 300, padding: 0.1 });
  };

  const toggleAutostart = async () => {
    try {
      setEnv({ autostart: await call('autostart:set', !env?.autostart) });
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  return (
    <header className="fd-toolbar">
      <span className="fd-brand">FlowDeck</span>
      <button className="fd-btn fd-btn-primary" onClick={() => openDialog({})} title="New node (Ctrl+Shift+N)" data-testid="new-node">
        + New node <kbd>Ctrl+Shift+N</kbd>
      </button>
      <button className="fd-btn" onClick={() => void duplicateSelected()} title="Duplicate the selected node (Ctrl+Shift+D)" data-testid="duplicate">
        Duplicate
      </button>
      <button
        className={`fd-btn ${drawMode === 'group' ? 'active' : ''}`}
        onClick={() => (drawMode === 'group' ? setDrawMode(null) : startGroup())}
        title="Group: wraps the selected terminals, or drag a rectangle on the canvas (Ctrl+Shift+G)"
        data-testid="draw-group"
      >
        ▭ Group
      </button>
      <button
        className={`fd-btn ${drawMode === 'text' ? 'active' : ''}`}
        onClick={() => setDrawMode(drawMode === 'text' ? null : 'text')}
        title="Text: click or drag on the canvas to add a caption (Ctrl+Shift+X)"
        data-testid="draw-text"
      >
        T Text
      </button>
      <button className="fd-btn" onClick={fitAll} data-testid="fit">
        Fit
      </button>
      <label className="fd-inline" title="Direction of new connections">
        New links:
        <select value={direction} onChange={(e) => setDirection(e.target.value as 'both' | 'one_way')}>
          <option value="both">two-way</option>
          <option value="one_way">one-way</option>
        </select>
      </label>
      <span className="fd-spacer" />
      {env && !env.tmuxAvailable && <span className="fd-warn">tmux not found — install tmux ≥ 3.3</span>}
      {missing.length > 0 && (
        <span className="fd-muted" title="Install the CLI and restart FlowDeck to enable it">
          not found: {missing.map((k) => AGENT_LABEL[k]).join(', ')}
        </span>
      )}
      <label className="fd-inline" title="Open FlowDeck when you log in">
        <input type="checkbox" checked={env?.autostart ?? false} onChange={() => void toggleAutostart()} />
        Start at login
      </label>
      <TabButton id="launch" label="Launch" testId="toggle-launch" />
      <TabButton id="terminals" label={<TerminalsTabLabel />} testId="toggle-terminals" />
      <TabButton id="accounts" label="Accounts" testId="toggle-accounts" />
      <TabButton id="messages" label="Messages" testId="toggle-messages" />
    </header>
  );
}

function Shell() {
  useMainEvents();
  useShortcuts();
  const loaded = useStore((s) => s.loaded);
  const panel = useStore((s) => s.panel);
  const dialog = useStore((s) => s.dialog);
  const openDialog = useStore((s) => s.openDialog);
  const closeDialog = useStore((s) => s.closeDialog);
  const templateDialog = useStore((s) => s.templateDialog);
  const closeTemplateDialog = useStore((s) => s.closeTemplateDialog);
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);

  return (
    <div className="fd-app">
      <Toolbar />
      <main className="fd-main">
        <div className="fd-canvas">{loaded && <Canvas />}</div>
        {panel === 'terminals' && <TerminalsPanel />}
        {panel === 'accounts' && (
          <AccountsPanel onLogin={(account) => openDialog({ kind: account.agent, account: account.id, title: `Login: ${account.label}` })} />
        )}
        {panel === 'messages' && <MessagesPanel />}
        {panel === 'launch' && <LaunchPanel />}
      </main>
      {dialog && <NewNodeDialog initial={dialog} onClose={closeDialog} />}
      {templateDialog && <TemplateDialog initial={templateDialog} onClose={closeTemplateDialog} />}
      <div className="fd-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`fd-toast fd-toast-${t.kind}`} onClick={() => dismiss(t.id)} role="alert">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
