import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AGENT_LABEL, type NodeState, type NodeView } from '@flowdeck/shared';
import { call } from '../api';
import { Bullet, Legend, STATE_INFO } from '../status/legend';
import { useStore } from '../store/store';

/** Control room: every terminal with its live state, attention first. */
export function TerminalsPanel() {
  const nodes = useStore((s) => s.nodes);
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const upsertNode = useStore((s) => s.upsertNode);
  const bumpAttach = useStore((s) => s.bumpAttach);
  const flow = useReactFlow();
  const [renaming, setRenaming] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      Object.values(nodes).sort(
        (a, b) => STATE_INFO[a.status.state].order - STATE_INFO[b.status.state].order || a.createdAt - b.createdAt,
      ),
    [nodes],
  );

  const counts = useMemo(() => {
    const c = new Map<NodeState, number>();
    for (const n of rows) c.set(n.status.state, (c.get(n.status.state) ?? 0) + 1);
    return [...c.entries()].sort(([a], [b]) => STATE_INFO[a].order - STATE_INFO[b].order);
  }, [rows]);

  const goTo = (n: NodeView) => {
    useStore.getState().selectOnly(n.id);
    void flow.setCenter(n.x + n.w / 2, n.y + n.h / 2, { zoom: 1, duration: 300 });
  };

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const duplicate = (n: NodeView) =>
    run(async () => {
      const copy = await call('node:duplicate', n.id);
      upsertNode(copy);
      goTo(copy);
    });

  const resume = (n: NodeView) =>
    run(async () => {
      upsertNode(await call('node:restart', n.id));
      bumpAttach(n.id);
    });

  const close = (n: NodeView) =>
    run(async () => {
      if (!window.confirm(`Close "${n.title}"? Its process will be terminated.`)) return;
      await call('node:delete', n.id);
      useStore.getState().removeNode(n.id);
    });

  const rename = (n: NodeView, title: string) =>
    run(async () => {
      setRenaming(null);
      if (!title.trim() || title === n.title) return;
      upsertNode(await call('node:update', n.id, { title }));
    });

  return (
    <aside className="fd-panel" data-testid="terminals-panel">
      <h2>Terminals</h2>
      <div className="fd-counts" data-testid="state-counts">
        {counts.length === 0 && <span className="fd-muted">No terminals yet — press Ctrl+Shift+N.</span>}
        {counts.map(([state, n]) => (
          <span key={state} className="fd-count">
            <Bullet state={state} /> {n} {STATE_INFO[state].label.toLowerCase()}
          </span>
        ))}
      </div>

      <div className="fd-term-list">
        {rows.map((n) => {
          const account = accounts.find((a) => a.id === n.accountId);
          return (
            <div
              key={n.id}
              className={`fd-term-row ${n.dangerous ? 'fd-term-danger' : ''}`}
              data-testid="terminal-row"
              data-state={n.status.state}
            >
              <Bullet state={n.status.state} />
              {renaming === n.id ? (
                <div className="fd-term-main">
                  <input
                    className="fd-title-input"
                    defaultValue={n.title}
                    autoFocus
                    maxLength={80}
                    data-testid="row-title-input"
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => void rename(n, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(n, e.currentTarget.value);
                      if (e.key === 'Escape') {
                        e.currentTarget.value = n.title; // the blur on unmount then saves nothing
                        setRenaming(null);
                      }
                    }}
                  />
                </div>
              ) : (
                <button className="fd-term-main" onClick={() => goTo(n)} title={`${n.cwd}\nGo to this terminal`}>
                  <span className="fd-term-title">{n.title}</span>
                  <span className="fd-term-meta">
                    <span className={`fd-kind fd-kind-${n.kind}`}>{AGENT_LABEL[n.kind]}</span>
                    {account && (
                      <span className="fd-term-account">
                        <span className="fd-badge-dot" style={{ background: account.color }} />
                        {account.label}
                      </span>
                    )}
                    <span className="fd-term-state">{STATE_INFO[n.status.state].label}</span>
                    {n.queued > 0 && <span className="fd-tag">{n.queued} queued</span>}
                  </span>
                  {n.status.state === 'needs_input' && n.status.detail && <span className="fd-term-detail">{n.status.detail}</span>}
                </button>
              )}
              <span className="fd-term-actions">
                {n.status.state === 'dead' && (
                  <button className="fd-icon" title="Resume" onClick={() => void resume(n)} data-testid="row-resume">
                    ↻
                  </button>
                )}
                <button className="fd-icon" title="Rename" onClick={() => setRenaming(n.id)} data-testid="row-rename">
                  ✎
                </button>
                <button className="fd-icon" title="Duplicate (Ctrl+Shift+D)" onClick={() => void duplicate(n)} data-testid="row-duplicate">
                  ⧉
                </button>
                <button className="fd-icon" title="Close" onClick={() => void close(n)}>
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <h3>Legend</h3>
      <Legend />
      <h3>Shortcuts</h3>
      <div className="fd-legend">
        <div className="fd-legend-row">
          <kbd>Ctrl+Shift+N</kbd>
          <span className="fd-muted">New node (remembers your last choices)</span>
        </div>
        <div className="fd-legend-row">
          <kbd>Ctrl+Shift+D</kbd>
          <span className="fd-muted">Duplicate the selected node</span>
        </div>
        <div className="fd-legend-row">
          <kbd>Ctrl+Shift+G</kbd>
          <span className="fd-muted">Group the selected terminals, or draw a group</span>
        </div>
        <div className="fd-legend-row">
          <kbd>Ctrl+Shift+X</kbd>
          <span className="fd-muted">Add a text to the canvas</span>
        </div>
        <div className="fd-legend-row">
          <kbd>Middle click</kbd>
          <span className="fd-muted">Paste the selection into a terminal (selecting copies)</span>
        </div>
        <div className="fd-legend-row">
          <kbd>Ctrl+Shift+V</kbd>
          <span className="fd-muted">Paste the clipboard into a terminal</span>
        </div>
      </div>
    </aside>
  );
}
