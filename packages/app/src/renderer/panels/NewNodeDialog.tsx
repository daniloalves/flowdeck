import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AGENT_LABEL, type NodeKind } from '@flowdeck/shared';
import { call } from '../api';
import { useStore, type DialogState } from '../store/store';
import { DEFAULT_NODE_SIZE, KindField, LaunchFields, accountAgentOf, isAvailable, pickAccount, toLaunchArgs } from './nodeFields';

const PREFS_KEY = 'flowdeck.newNode';
const GAP = 40;

interface Prefs {
  kind: NodeKind;
  cwd: string;
  accounts: Partial<Record<NodeKind, string>>;
  extra: Partial<Record<NodeKind, string>>;
}

/** Last choices, per viewer; the dialog works the same without them. */
function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

export function NewNodeDialog({ initial, onClose }: { initial: DialogState; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const env = useStore((s) => s.env);
  const upsertNode = useStore((s) => s.upsertNode);
  const toast = useStore((s) => s.toast);
  const openTemplateDialog = useStore((s) => s.openTemplateDialog);
  const flow = useReactFlow();
  const [prefs] = useState(loadPrefs);

  const firstKind = initial.kind ?? (prefs.kind && isAvailable(prefs.kind, env?.agents) ? prefs.kind : 'claude');
  const [kind, setKind] = useState<NodeKind>(firstKind);
  const [title, setTitle] = useState(initial.title ?? '');
  const [cwd, setCwd] = useState(prefs.cwd ?? env?.home ?? '');
  const [chosen, setChosen] = useState<Partial<Record<NodeKind, string>>>({
    ...prefs.accounts,
    ...(initial.account ? { [firstKind]: initial.account } : {}),
  });
  const [extra, setExtra] = useState<Partial<Record<NodeKind, string>>>(prefs.extra ?? {});
  const [skip, setSkip] = useState(false);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);

  // Escape closes the dialog wherever the focus is (it may still be in a terminal).
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

  const accountAgent = accountAgentOf(kind);
  const accountId = pickAccount(kind, accounts, chosen[kind]);
  const config = { kind, cwd, accountId, extra: extra[kind] ?? '', skip };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const launchArgs = toLaunchArgs(config);
      const baseTitle = title.trim() || cwd.split('/').filter(Boolean).pop() || AGENT_LABEL[kind];
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const size = DEFAULT_NODE_SIZE;
      const cols = Math.min(count, 3);
      const created = [];
      for (let i = 0; i < count; i++) {
        const node = await call('node:create', {
          kind,
          title: count > 1 ? `${baseTitle.slice(0, 74)} #${i + 1}` : baseTitle,
          cwd: cwd.trim(),
          accountId: accountAgent ? accountId || null : null,
          launchArgs,
          layout: {
            x: center.x - (cols * (size.w + GAP)) / 2 + (i % cols) * (size.w + GAP),
            y: center.y - size.h / 2 + Math.floor(i / cols) * (size.h + GAP),
            ...size,
          },
        });
        upsertNode(node);
        created.push(node);
      }
      savePrefs({ kind, cwd: cwd.trim(), accounts: { ...chosen, [kind]: accountId }, extra });
      if (created.length > 1) toast('info', `${created.length} ${AGENT_LABEL[kind]} nodes created`);
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Opens the template editor with these settings; this dialog closes. */
  const saveAsTemplate = () => {
    onClose();
    openTemplateDialog({
      name: title.trim() || cwd.split('/').filter(Boolean).pop() || AGENT_LABEL[kind],
      kind,
      title: title.trim(),
      cwd: cwd.trim(),
      accountId: accountAgent ? accountId || null : null,
      launchArgs: toLaunchArgs(config),
      ...DEFAULT_NODE_SIZE,
    });
  };

  return (
    <div className="fd-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="fd-modal" onSubmit={(e) => void submit(e)} data-testid="new-node-dialog">
        <h2>New node</h2>
        <KindField kind={kind} onChange={setKind} />
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="defaults to the folder name"
            name="title"
            autoFocus
          />
        </label>
        <LaunchFields
          value={config}
          onChange={(patch) => {
            if (patch.cwd !== undefined) setCwd(patch.cwd);
            if (patch.accountId !== undefined) setChosen({ ...chosen, [kind]: patch.accountId });
            if (patch.extra !== undefined) setExtra({ ...extra, [kind]: patch.extra });
            if (patch.skip !== undefined) setSkip(patch.skip);
          }}
        />
        <label className="fd-inline-field">
          How many
          <input
            type="number"
            min={1}
            max={6}
            value={count}
            onChange={(e) => setCount(Math.min(6, Math.max(1, Number(e.target.value) || 1)))}
            name="count"
          />
        </label>
        <div className="fd-actions">
          <span className="fd-muted fd-kbd-hint">
            <kbd>Ctrl+Shift+N</kbd> opens this dialog
          </span>
          <button type="button" className="fd-btn" onClick={saveAsTemplate} title="Save these settings as a template for the Launch panel" data-testid="save-as-template">
            Save as template…
          </button>
          <button type="button" className="fd-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="fd-btn fd-btn-primary" disabled={busy || (accountAgent !== null && !accountId)} data-testid="create-node">
            {count > 1 ? `Create ${count}` : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
