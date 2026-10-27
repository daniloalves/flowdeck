import { useEffect, useState } from 'react';
import { LIMITS, type NodeKind } from '@flowdeck/shared';
import { call } from '../api';
import { useStore, type TemplateDraft } from '../store/store';
import { DEFAULT_NODE_SIZE, KindField, LaunchFields, accountAgentOf, fromLaunchArgs, pickAccount, toLaunchArgs, type LaunchConfig } from './nodeFields';

/** Creates or edits a node template (the settings the Launch panel starts nodes with). */
export function TemplateDialog({ initial, onClose }: { initial: TemplateDraft; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const env = useStore((s) => s.env);
  const toast = useStore((s) => s.toast);
  const upsertTemplate = useStore((s) => s.upsertTemplate);
  const kind0: NodeKind = initial.kind ?? 'claude';
  const [name, setName] = useState(initial.name ?? '');
  const [title, setTitle] = useState(initial.title ?? '');
  const [config, setConfig] = useState<LaunchConfig>({
    kind: kind0,
    cwd: initial.cwd ?? env?.home ?? '',
    accountId: pickAccount(kind0, accounts, initial.accountId),
    ...fromLaunchArgs(kind0, initial.launchArgs ?? []),
  });
  const [w, setW] = useState(initial.w ?? DEFAULT_NODE_SIZE.w);
  const [h, setH] = useState(initial.h ?? DEFAULT_NODE_SIZE.h);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const setKind = (kind: NodeKind) =>
    setConfig((c) => ({ ...c, kind, accountId: pickAccount(kind, accounts, c.accountId) }));
  const accountAgent = accountAgentOf(config.kind);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const input = {
      name: name.trim(),
      kind: config.kind,
      title: title.trim(),
      cwd: config.cwd.trim(),
      accountId: accountAgent ? config.accountId || null : null,
      launchArgs: toLaunchArgs(config),
      w,
      h,
    };
    try {
      const saved = initial.id ? await call('template:update', initial.id, input) : await call('template:create', input);
      upsertTemplate(saved);
      toast('info', `Template “${saved.name}” saved`);
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fd-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="fd-modal" onSubmit={(e) => void submit(e)} data-testid="template-dialog">
        <h2>{initial.id ? 'Edit template' : 'New template'}</h2>
        <label>
          Template name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.titleChars} required name="name" autoFocus />
        </label>
        <KindField kind={config.kind} onChange={setKind} />
        <label>
          Node title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={LIMITS.titleChars}
            placeholder="defaults to the folder name; can be changed at launch"
            name="title"
          />
        </label>
        <LaunchFields value={config} onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))} />
        <div className="fd-row fd-size-fields">
          <label className="fd-inline-field">
            Width
            <input type="number" min={160} max={8000} step={10} value={w} onChange={(e) => setW(Number(e.target.value) || DEFAULT_NODE_SIZE.w)} name="w" />
          </label>
          <label className="fd-inline-field">
            Height
            <input type="number" min={100} max={8000} step={10} value={h} onChange={(e) => setH(Number(e.target.value) || DEFAULT_NODE_SIZE.h)} name="h" />
          </label>
          <span className="fd-muted">terminal size on the canvas</span>
        </div>
        <div className="fd-actions">
          <button type="button" className="fd-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="fd-btn fd-btn-primary"
            disabled={busy || !name.trim() || (accountAgent !== null && !config.accountId)}
            data-testid="save-template"
          >
            Save template
          </button>
        </div>
      </form>
    </div>
  );
}
