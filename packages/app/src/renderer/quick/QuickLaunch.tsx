import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_LABEL, LIMITS, composeTask, folderName, utf8Bytes, type QuickLaunchState, type QuickTemplate } from '@flowdeck/shared';
import { call, on } from '../api';
import { GroupSelect, TaskPreview, lastGroup, lastTemplate } from '../panels/launchShared';

const SOURCE_LABEL: Record<QuickLaunchState['source'], string> = {
  selection: 'From the selected text',
  clipboard: 'From the clipboard (nothing was selected)',
  none: 'Nothing selected: type the task',
};

const matches = (t: QuickTemplate, filter: string): boolean => {
  const q = filter.trim().toLowerCase();
  return !q || `${t.name} ${AGENT_LABEL[t.kind]} ${t.cwd}`.toLowerCase().includes(q);
};

/**
 * The quick-launch window: opened by the global shortcut over any app, with the text selected
 * there. Enter launches, Esc closes. A template that skips approvals needs a second confirmation.
 */
export function QuickLaunch() {
  const [state, setState] = useState<QuickLaunchState | null>(null);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [groupId, setGroupId] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const show = useCallback((s: QuickLaunchState) => {
    const last = lastTemplate.load();
    const group = lastGroup.load();
    setState(s);
    setText(s.text);
    setFilter('');
    setTitle('');
    setArmed(false);
    setBusy(false);
    setError(null);
    setPicked(s.templates.some((t) => t.id === last) ? last : (s.templates[0]?.id ?? null));
    setGroupId(group && s.groups.some((g) => g.id === group) ? group : '');
    requestAnimationFrame(() => filterRef.current?.focus());
  }, []);

  useEffect(() => {
    const off = on('quick:show', show);
    call('quick:state')
      .then((s) => s && show(s))
      .catch(() => undefined);
    return off;
  }, [show]);

  const visible = state ? state.templates.filter((t) => matches(t, filter)) : [];
  const template = visible.find((t) => t.id === picked) ?? visible[0];
  const task = template ? composeTask(template.task, text) : text.trim();
  const bytes = utf8Bytes(task);
  const tooLong = bytes > LIMITS.taskBytes;

  const pick = (id: string) => {
    setPicked(id);
    setArmed(false);
  };

  const close = () => {
    setState(null);
    void call('quick:close').catch(() => undefined);
  };

  const launch = async () => {
    if (!template || busy || tooLong || template.problem) return;
    if (template.skipsApprovals && !armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call('quick:launch', { templateId: template.id, title: title.trim(), text, groupId: groupId || null });
      lastTemplate.save(template.id);
      lastGroup.save(groupId || null);
      setState(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void launch();
    }
  };

  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      void launch();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = visible.findIndex((t) => t.id === template?.id);
      const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) pick(next.id);
    }
  };

  if (!state) return <div className="fd-quick" data-testid="quick-launch-idle" />;

  return (
    <div className="fd-quick" data-testid="quick-launch" onKeyDown={onKeyDown}>
      <header className="fd-quick-head">
        <strong>Launch a task</strong>
        <span className="fd-muted" data-testid="quick-source">
          {SOURCE_LABEL[state.source]}
        </span>
        <button type="button" className="fd-icon" onClick={close} title="Close (Esc)">
          ✕
        </button>
      </header>

      <input
        ref={filterRef}
        className="fd-quick-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={onFilterKey}
        placeholder="Search templates…  ↑↓ to pick, Enter to launch"
        data-testid="quick-filter"
      />
      <div className="fd-quick-list" role="listbox" aria-label="Templates">
        {state.templates.length === 0 && <p className="fd-muted">Create a template in FlowDeck's Launch panel first.</p>}
        {visible.map((t) => (
          <button
            key={t.id}
            type="button"
            role="option"
            aria-selected={t.id === template?.id}
            className={`fd-quick-item ${t.id === template?.id ? 'active' : ''} ${t.skipsApprovals ? 'fd-term-danger' : ''}`}
            onClick={() => pick(t.id)}
            onDoubleClick={() => void launch()}
            data-testid="quick-template"
          >
            <span className="fd-term-title">{t.name}</span>
            <span className="fd-term-meta">
              <span className={`fd-kind fd-kind-${t.kind}`}>{AGENT_LABEL[t.kind]}</span>
              {t.skipsApprovals && <span className="fd-tag fd-warn">skips approvals</span>}
              {t.problem && <span className="fd-tag fd-warn">{t.problem}</span>}
              <span className="fd-term-state">{folderName(t.cwd)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="fd-row fd-quick-fields">
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                void launch();
              }
            }}
            maxLength={LIMITS.titleChars}
            placeholder={template ? template.title || folderName(template.cwd) : ''}
            data-testid="quick-title"
          />
        </label>
        <GroupSelect groups={state.groups} value={groupId} onChange={setGroupId} testId="quick-group" />
      </div>
      <label>
        {template?.task.trim() ? 'Text for the template' : 'Task'}
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} data-testid="quick-text" />
      </label>
      {template && <TaskPreview templateTask={template.task} text={text} />}

      <div className="fd-launch-meta">
        <span className={tooLong ? 'fd-warn' : 'fd-muted'} data-testid="quick-bytes">
          {(bytes / 1024).toFixed(1)} / {LIMITS.taskBytes / 1024} KB
        </span>
        {state.truncated && <span className="fd-warn">The selection was cut at {LIMITS.selectionChars / 1024} K characters.</span>}
      </div>
      {template?.skipsApprovals && (
        <p className="fd-warn fd-launch-note">
          This template skips approval prompts: the agent acts on this text without asking. Launch it only if you trust where
          the text came from.
        </p>
      )}
      {template?.problem && <p className="fd-warn fd-launch-note">Cannot launch: {template.problem}. Edit the template in FlowDeck.</p>}
      {error && (
        <p className="fd-warn fd-launch-note" role="alert" data-testid="quick-error">
          {error}
        </p>
      )}
      <div className="fd-actions">
        <button type="button" className="fd-btn" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className={`fd-btn ${armed ? 'fd-btn-danger' : 'fd-btn-primary'}`}
          onClick={() => void launch()}
          disabled={busy || tooLong || !template || Boolean(template.problem)}
          data-testid="quick-launch-button"
        >
          {armed ? 'Launch without approvals' : 'Launch'} <kbd>Enter</kbd>
        </button>
      </div>
    </div>
  );
}
