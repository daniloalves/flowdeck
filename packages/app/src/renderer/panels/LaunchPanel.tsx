import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AGENT_LABEL, LIMITS, SKIP_APPROVALS_FLAG, isAgentKind, utf8Bytes, type NodeTemplate } from '@flowdeck/shared';
import { call } from '../api';
import { useStore } from '../store/store';
import { accountAgentOf } from './nodeFields';

const PREFS_KEY = 'flowdeck.launch';

/** The template picked last, per viewer; the panel works the same without it. */
function loadLastTemplate(): string | null {
  try {
    return localStorage.getItem(PREFS_KEY);
  } catch {
    return null;
  }
}

function saveLastTemplate(id: string): void {
  try {
    localStorage.setItem(PREFS_KEY, id);
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

const folderName = (cwd: string): string => cwd.split('/').filter(Boolean).pop() ?? cwd;
const skipsApprovals = (t: NodeTemplate): boolean => isAgentKind(t.kind) && t.launchArgs.includes(SKIP_APPROVALS_FLAG[t.kind]);

/** `base`, or `base #n` when a node already has that title (peers are addressed by title). */
function uniqueTitle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const stem = base.replace(/ #\d+$/, '').slice(0, LIMITS.titleChars - 6);
  let n = 2;
  while (taken.has(`${stem} #${n}`)) n++;
  return `${stem} #${n}`;
}

/** Launch a task: pick a template, name the node, write its first task. Also manages templates. */
export function LaunchPanel() {
  const templates = useStore((s) => s.templates);
  const accounts = useStore((s) => s.accounts);
  const home = useStore((s) => s.env?.home ?? '');
  const toast = useStore((s) => s.toast);
  const openTemplateDialog = useStore((s) => s.openTemplateDialog);
  const flow = useReactFlow();
  const [picked, setPicked] = useState<string | null>(loadLastTemplate);
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);

  const template = templates.find((t) => t.id === picked) ?? templates[0];
  const bytes = utf8Bytes(task);
  const tooLong = bytes > LIMITS.taskBytes;

  /** Why a template cannot be launched as it stands, or null. */
  const problem = (t: NodeTemplate): string | null => {
    const agent = accountAgentOf(t.kind);
    if (agent && !accounts.some((a) => a.id === t.accountId && a.agent === agent)) return 'account missing';
    return null;
  };

  const pick = (id: string) => {
    setPicked(id);
    saveLastTemplate(id);
  };

  const launch = async () => {
    if (!template || busy || tooLong) return;
    setBusy(true);
    try {
      const st = useStore.getState();
      const taken = new Set(Object.values(st.nodes).map((n) => n.title));
      const name = uniqueTitle(title.trim() || template.title || folderName(template.cwd), taken);
      // Centre of the view; step aside while another node starts at the same spot.
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      let x = center.x - template.w / 2;
      let y = center.y - template.h / 2;
      while (Object.values(st.nodes).some((n) => Math.abs(n.x - x) < 30 && Math.abs(n.y - y) < 30)) {
        x += 40;
        y += 40;
      }
      const node = await call('node:create', {
        kind: template.kind,
        title: name,
        cwd: template.cwd,
        accountId: template.accountId,
        launchArgs: template.launchArgs,
        layout: { x, y, w: template.w, h: template.h },
        ...(task.trim() ? { task } : {}),
      });
      st.upsertNode(node);
      st.selectOnly(node.id);
      void flow.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom: 1, duration: 300 });
      toast('info', task.trim() ? `“${node.title}” launched with its task` : `“${node.title}” launched`);
      setTask('');
      setTitle('');
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: NodeTemplate) => {
    if (!window.confirm(`Delete the template "${t.name}"? Nodes launched from it stay.`)) return;
    try {
      await call('template:delete', t.id);
      useStore.getState().removeTemplate(t.id);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const shortPath = (p: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

  return (
    <aside className="fd-panel" data-testid="launch-panel">
      <h2>Launch a task</h2>
      {templates.length === 0 ? (
        <p className="fd-muted">
          Create a template first: it holds the type, folder, account, arguments and size of the nodes you launch.
        </p>
      ) : (
        <form
          className="fd-form fd-launch-form"
          onSubmit={(e) => {
            e.preventDefault();
            void launch();
          }}
        >
          <label>
            Template
            <select value={template?.id ?? ''} onChange={(e) => pick(e.target.value)} name="template" data-testid="launch-template">
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {AGENT_LABEL[t.kind]}
                </option>
              ))}
            </select>
          </label>
          {template && skipsApprovals(template) && (
            <p className="fd-warn fd-launch-note">Skips approval prompts: the agent works on the task without asking.</p>
          )}
          {template && problem(template) && <p className="fd-warn fd-launch-note">This template's account is missing: edit it first.</p>}
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={LIMITS.titleChars}
              placeholder={template ? template.title || folderName(template.cwd) : ''}
              name="title"
              data-testid="launch-title"
            />
          </label>
          <label>
            Task
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void launch();
                }
              }}
              rows={8}
              placeholder={template && !isAgentKind(template.kind) ? 'Commands to run in the shell' : 'What should the agent do? (optional)'}
              name="task"
              autoFocus
              data-testid="launch-task"
            />
          </label>
          <div className="fd-launch-meta">
            <span className={tooLong ? 'fd-warn' : 'fd-muted'} data-testid="launch-bytes">
              {(bytes / 1024).toFixed(1)} / {LIMITS.taskBytes / 1024} KB
            </span>
            <span className="fd-muted" title="It is passed to the agent as its first prompt, on its command line.">
              Visible to local processes while the agent runs: no secrets.
            </span>
          </div>
          <div className="fd-actions">
            <button type="submit" className="fd-btn fd-btn-primary" disabled={busy || tooLong || !template} data-testid="launch">
              Launch <kbd>Ctrl+Enter</kbd>
            </button>
          </div>
        </form>
      )}

      <h3 className="fd-launch-templates">
        Templates
        <button type="button" className="fd-btn" onClick={() => openTemplateDialog({})} data-testid="new-template">
          + New template
        </button>
      </h3>
      <div className="fd-term-list">
        {templates.map((t) => {
          const account = accounts.find((a) => a.id === t.accountId);
          const issue = problem(t);
          return (
            <div key={t.id} className={`fd-term-row ${skipsApprovals(t) ? 'fd-term-danger' : ''}`} data-testid="template-row">
              <button className="fd-term-main" onClick={() => pick(t.id)} title={`${t.cwd}\nUse this template`}>
                <span className="fd-term-title">
                  {t.id === template?.id && '▸ '}
                  {t.name}
                </span>
                <span className="fd-term-meta">
                  <span className={`fd-kind fd-kind-${t.kind}`}>{AGENT_LABEL[t.kind]}</span>
                  {account && (
                    <span className="fd-term-account">
                      <span className="fd-badge-dot" style={{ background: account.color }} />
                      {account.label}
                    </span>
                  )}
                  {issue && <span className="fd-tag fd-warn">{issue}</span>}
                  <span className="fd-term-state">{shortPath(t.cwd)}</span>
                </span>
              </button>
              <span className="fd-term-actions">
                <button className="fd-icon" title="Edit" onClick={() => openTemplateDialog(t)} data-testid="template-edit">
                  ✎
                </button>
                <button
                  className="fd-icon"
                  title="Duplicate"
                  onClick={() => {
                    const { id: _id, createdAt: _createdAt, ...copy } = t;
                    openTemplateDialog({ ...copy, name: `${t.name.slice(0, LIMITS.titleChars - 7)} (copy)` });
                  }}
                >
                  ⧉
                </button>
                <button className="fd-icon" title="Delete" onClick={() => void remove(t)} data-testid="template-delete">
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
