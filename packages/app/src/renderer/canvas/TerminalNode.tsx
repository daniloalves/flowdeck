import { memo, useCallback, useState } from 'react';
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { AGENT_LABEL, isAgentKind, type NodeState } from '@flowdeck/shared';
import { call } from '../api';
import { formatTokens, useStore } from '../store/store';
import { Terminal } from '../terminal/Terminal';

export type TerminalNodeData = { nodeId: string };
export type TerminalFlowNode = Node<TerminalNodeData, 'terminal'>;

const STATE_LABEL: Record<NodeState, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  needs_input: 'needs input',
  dead: 'stopped',
  unknown: 'unknown',
};

function UsageBadge({ accountId }: { accountId: string }) {
  const account = useStore((s) => s.accounts.find((a) => a.id === accountId));
  const usage = useStore((s) => s.usage[accountId]);
  if (!account) return <span className="fd-badge">missing account</span>;
  if (account.agent !== 'claude') {
    return (
      <span className="fd-badge" style={{ borderColor: account.color }} title={`${account.configDir}\nUsage is only read for Claude Code accounts`} data-testid="account-badge">
        <span className="fd-badge-dot" style={{ background: account.color }} />
        {account.label}
        <span className="fd-badge-usage">usage n/a</span>
      </span>
    );
  }
  const block = usage?.block ? usage.block.inputTokens + usage.block.outputTokens : 0;
  const week = usage ? usage.week.inputTokens + usage.week.outputTokens : 0;
  const pct = (v: number, cap: number | null) => (cap ? ` (${Math.round((v / cap) * 100)}%)` : '');
  return (
    <span
      className="fd-badge"
      style={{ borderColor: account.color }}
      title={`${account.configDir}\n5 h block: ${block.toLocaleString()} tokens\n7 days: ${week.toLocaleString()} tokens\n(input + output; cache excluded)`}
      data-testid="account-badge"
    >
      <span className="fd-badge-dot" style={{ background: account.color }} />
      {account.label}
      <span className="fd-badge-usage">
        5h {formatTokens(block)}
        {pct(block, account.cap5h)} · 7d {formatTokens(week)}
        {pct(week, account.cap7d)}
      </span>
    </span>
  );
}

function TerminalNodeImpl({ data, selected }: NodeProps<TerminalFlowNode>) {
  const node = useStore((s) => s.nodes[data.nodeId]);
  const generation = useStore((s) => s.attachGen[data.nodeId] ?? 0);
  const bumpAttach = useStore((s) => s.bumpAttach);
  const toast = useStore((s) => s.toast);
  const upsertNode = useStore((s) => s.upsertNode);
  const [editing, setEditing] = useState(false);
  const [detached, setDetached] = useState(false);
  const flow = useReactFlow();

  const onDetached = useCallback(() => setDetached(true), []);

  if (!node) return null;
  const state = node.status.state;

  const restart = async () => {
    try {
      const v = await call('node:restart', node.id);
      upsertNode(v);
      setDetached(false);
      bumpAttach(node.id);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const reattach = () => {
    setDetached(false);
    bumpAttach(node.id);
  };

  const duplicate = async () => {
    try {
      upsertNode(await call('node:duplicate', node.id));
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Close "${node.title}"? Its process will be terminated.`)) return;
    try {
      await call('node:delete', node.id);
      useStore.getState().removeNode(node.id);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const rename = async (title: string) => {
    setEditing(false);
    if (!title.trim() || title === node.title) return;
    try {
      upsertNode(await call('node:update', node.id, { title }));
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const zoomTo100 = () => {
    void flow.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom: 1, duration: 250 });
  };

  return (
    <div
      className={`fd-node fd-state-${state} ${node.dangerous ? 'fd-dangerous' : ''}`}
      data-testid={`node-${node.id}`}
      data-state={state}
    >
      <NodeResizer isVisible={selected} minWidth={320} minHeight={200} lineClassName="fd-resize-line" />
      {isAgentKind(node.kind) && (
        <>
          <Handle type="target" position={Position.Left} className="fd-handle" />
          <Handle type="source" position={Position.Right} className="fd-handle" />
        </>
      )}
      <div className="fd-node-header" onDoubleClick={zoomTo100}>
        <span className="fd-state-dot" title={node.status.detail ?? STATE_LABEL[state]} />
        {editing ? (
          <input
            className="fd-title-input nodrag"
            defaultValue={node.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            data-testid="node-title-input"
            maxLength={80}
            onBlur={(e) => void rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename(e.currentTarget.value);
              if (e.key === 'Escape') {
                        e.currentTarget.value = node.title; // the blur on unmount then saves nothing
                        setEditing(false);
                      }
            }}
          />
        ) : (
          <span className="fd-title" onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))} title={`${node.cwd}\nDouble-click to rename`}>
            {node.title}
          </span>
        )}
        {!editing && (
          <button className="fd-icon nodrag" title="Rename" onClick={() => setEditing(true)} data-testid="node-rename">
            ✎
          </button>
        )}
        <span className="fd-state-label" data-testid="state-label">
          {STATE_LABEL[state]}
        </span>
        {node.dangerous && <span className="fd-tag fd-tag-danger">skip permissions</span>}
        {node.queued > 0 && <span className="fd-tag">{node.queued} queued</span>}
        <span className="fd-spacer" />
        <span className={`fd-kind fd-kind-${node.kind}`}>{AGENT_LABEL[node.kind]}</span>
        {node.accountId && <UsageBadge accountId={node.accountId} />}
        <button className="fd-icon nodrag" title="Duplicate (Ctrl+Shift+D)" onClick={() => void duplicate()} data-testid="node-duplicate">
          ⧉
        </button>
        <button className="fd-icon nodrag" title="Zoom to 100%" onClick={zoomTo100}>
          ⤢
        </button>
        <button className="fd-icon nodrag" title="Close node" onClick={() => void remove()}>
          ✕
        </button>
      </div>
      {state === 'needs_input' && node.status.detail && <div className="fd-detail">{node.status.detail}</div>}
      <div className="fd-node-body">
        <Terminal nodeId={node.id} generation={generation} onDetached={onDetached} />
        {(state === 'dead' || detached) && (
          <div className="fd-overlay nodrag">
            {state === 'dead' ? (
              <>
                <p>{node.status.detail ?? 'The process exited.'}</p>
                <button className="fd-btn fd-btn-primary" onClick={() => void restart()} data-testid="resume">
                  Resume
                </button>
              </>
            ) : (
              <>
                <p>Terminal detached.</p>
                <button className="fd-btn" onClick={reattach}>
                  Re-attach
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const TerminalNode = memo(TerminalNodeImpl);
