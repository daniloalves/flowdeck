import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  AGENT_LABEL,
  DEFAULT_QUICK_SHORTCUT,
  LIMITS,
  SKIP_APPROVALS_FLAG,
  acceleratorFromKey,
  composeTask,
  folderName,
  formatAccelerator,
  isAgentKind,
  utf8Bytes,
  type AfterQuickLaunch,
  type NodeTemplate,
  type SettingsPatch,
} from '@flowdeck/shared';
import { call } from '../api';
import { useStore } from '../store/store';
import { GroupSelect, TaskPreview, lastGroup, lastTemplate } from './launchShared';
import { accountAgentOf } from './nodeFields';

const skipsApprovals = (t: NodeTemplate): boolean => isAgentKind(t.kind) && t.launchArgs.includes(SKIP_APPROVALS_FLAG[t.kind]);

/** Launch a task: pick a template, name the node, write its first task. Also manages templates. */
export function LaunchPanel() {
  const templates = useStore((s) => s.templates);
  const accounts = useStore((s) => s.accounts);
  const home = useStore((s) => s.env?.home ?? '');
  const toast = useStore((s) => s.toast);
  const openTemplateDialog = useStore((s) => s.openTemplateDialog);
  const annotations = useStore((s) => s.annotations);
  const flow = useReactFlow();
  const [picked, setPicked] = useState<string | null>(lastTemplate.load);
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [group, setGroup] = useState(() => lastGroup.load() ?? '');
  const [busy, setBusy] = useState(false);

  const groupList = Object.values(annotations)
    .filter((a) => a.kind === 'group')
    .map((g) => ({ id: g.id, title: g.text.trim() || 'Untitled group' }));
  const groupId = groupList.some((g) => g.id === group) ? group : '';
  const template = templates.find((t) => t.id === picked) ?? templates[0];
  const bytes = utf8Bytes(template ? composeTask(template.task, task) : task.trim());
  const tooLong = bytes > LIMITS.taskBytes;

  /** Why a template cannot be launched as it stands, or null. */
  const problem = (t: NodeTemplate): string | null => {
    const agent = accountAgentOf(t.kind);
    if (agent && !accounts.some((a) => a.id === t.accountId && a.agent === agent)) return 'account missing';
    return null;
  };

  const pick = (id: string) => {
    setPicked(id);
    lastTemplate.save(id);
  };

  const pickGroup = (id: string) => {
    setGroup(id);
    lastGroup.save(id || null);
  };

  const launch = async () => {
    if (!template || busy || tooLong) return;
    setBusy(true);
    try {
      const st = useStore.getState();
      // Main picks a unique title and places the node in the group, or around the centre of the view.
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const node = await call('template:launch', { templateId: template.id, title: title.trim(), text: task, groupId: groupId || null, center });
      st.upsertNode(node);
      st.selectOnly(node.id);
      void flow.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom: 1, duration: 300 });
      toast('info', composeTask(template.task, task) ? `“${node.title}” launched with its task` : `“${node.title}” launched`);
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
          <GroupSelect groups={groupList} value={groupId} onChange={pickGroup} testId="launch-group" />
          <label>
            {template?.task.trim() ? 'Text for the template' : 'Task'}
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
          {template && <TaskPreview templateTask={template.task} text={task} />}
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

      <QuickLaunchSettings />
    </aside>
  );
}

/** The global quick-launch shortcut and what happens after a quick launch. */
function QuickLaunchSettings() {
  const settings = useStore((s) => s.settings);
  const active = useStore((s) => s.env?.quickShortcutActive ?? false);
  const setSettings = useStore((s) => s.setSettings);
  const setEnv = useStore((s) => s.setEnv);
  const toast = useStore((s) => s.toast);
  const [recording, setRecording] = useState(false);
  if (!settings) return null;
  const { shortcut, afterLaunch } = settings.quickLaunch;

  const save = async (patch: SettingsPatch) => {
    try {
      const r = await call('settings:update', patch);
      setSettings(r.settings);
      setEnv({ quickShortcutActive: r.shortcutActive });
      if (r.settings.quickLaunch.shortcut && !r.shortcutActive) toast('error', 'That shortcut could not be registered: choose another.');
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const record = (e: React.KeyboardEvent) => {
    if (!recording) return;
    if (['Control', 'Alt', 'Shift', 'Meta', 'Super', 'OS'].includes(e.key)) return; // wait for the key itself
    e.preventDefault();
    e.stopPropagation();
    setRecording(false);
    if (e.key === 'Escape') return;
    const accelerator = acceleratorFromKey(e.nativeEvent);
    if (accelerator) void save({ quickLaunch: { shortcut: accelerator } });
    else toast('info', 'Use Ctrl, Alt or Super with a letter, digit, F-key or Space.');
  };

  return (
    <section className="fd-quick-settings" data-testid="quick-settings">
      <h3 className="fd-launch-templates">Quick launch</h3>
      <p className="fd-muted fd-launch-note">
        Select text in any app and press the shortcut to launch a task with it. If pressing it does nothing, another app
        uses it: choose another. On Wayland, bind <code>flowdeck --quick-launch</code> to a shortcut in your desktop settings.
      </p>
      <div className="fd-row">
        <button
          type="button"
          className={`fd-btn fd-shortcut ${recording ? 'active' : ''}`}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={record}
          title="Click, then press the new shortcut (Esc cancels)"
          data-testid="quick-shortcut"
        >
          {recording ? 'Press keys…' : formatAccelerator(shortcut)}
        </button>
        <span className={active ? 'fd-ok' : 'fd-muted'} data-testid="quick-shortcut-state">
          {active ? 'on' : 'off'}
        </span>
        <span className="fd-spacer" />
        {shortcut !== DEFAULT_QUICK_SHORTCUT && (
          <button type="button" className="fd-btn" onClick={() => void save({ quickLaunch: { shortcut: DEFAULT_QUICK_SHORTCUT } })}>
            Reset
          </button>
        )}
        {shortcut && (
          <button type="button" className="fd-btn" onClick={() => void save({ quickLaunch: { shortcut: '' } })} data-testid="quick-shortcut-off">
            Turn off
          </button>
        )}
      </div>
      <label className="fd-inline-field">
        After a quick launch
        <select
          value={afterLaunch}
          onChange={(e) => void save({ quickLaunch: { afterLaunch: e.target.value as AfterQuickLaunch } })}
          data-testid="quick-after"
        >
          <option value="stay">stay in the app I came from</option>
          <option value="flowdeck">go to FlowDeck</option>
        </select>
      </label>
    </section>
  );
}
