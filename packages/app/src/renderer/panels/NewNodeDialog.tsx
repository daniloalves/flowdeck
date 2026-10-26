import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AGENT_LABEL, SKIP_APPROVALS_FLAG, isAgentKind, type NodeKind } from '@flowdeck/shared';
import { call } from '../api';
import { useStore, type DialogState } from '../store/store';

const KINDS: NodeKind[] = ['claude', 'codex', 'kiro', 'shell'];
const PREFS_KEY = 'flowdeck.newNode';
const SIZE = { w: 720, h: 440 };
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

const HINT: Partial<Record<NodeKind, string>> = {
  codex:
    "The first Codex launch per account asks you to review FlowDeck's hooks: choose “Trust all and continue” (or run /hooks and press t) once, so status and messages work.",
  kiro: 'Kiro status comes from terminal activity (no “needs you” state). Kiro can receive messages but not send them yet.',
};

export function NewNodeDialog({ initial, onClose }: { initial: DialogState; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const env = useStore((s) => s.env);
  const upsertNode = useStore((s) => s.upsertNode);
  const toast = useStore((s) => s.toast);
  const flow = useReactFlow();
  const [prefs] = useState(loadPrefs);

  const available = (k: NodeKind) => !isAgentKind(k) || Boolean(env?.agents[k]);
  const firstKind = initial.kind ?? (prefs.kind && available(prefs.kind) ? prefs.kind : 'claude');
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

  const accountAgent = kind === 'claude' || kind === 'codex' ? kind : null;
  const kindAccounts = accounts.filter((a) => a.agent === accountAgent);
  const accountId = accountAgent ? (chosen[kind] && kindAccounts.some((a) => a.id === chosen[kind]) ? chosen[kind]! : (kindAccounts[0]?.id ?? '')) : '';

  const browse = async () => {
    const dir = await call('dialog:pickDirectory').catch(() => null);
    if (dir) setCwd(dir);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const launchArgs = isAgentKind(kind)
        ? [...(extra[kind] ?? '').split(/\s+/).filter(Boolean), ...(skip ? [SKIP_APPROVALS_FLAG[kind]] : [])]
        : [];
      const baseTitle = title.trim() || cwd.split('/').filter(Boolean).pop() || AGENT_LABEL[kind];
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
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
            x: center.x - (cols * (SIZE.w + GAP)) / 2 + (i % cols) * (SIZE.w + GAP),
            y: center.y - SIZE.h / 2 + Math.floor(i / cols) * (SIZE.h + GAP),
            ...SIZE,
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

  return (
    <div className="fd-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="fd-modal"
        onSubmit={(e) => void submit(e)}
        data-testid="new-node-dialog"
      >
        <h2>New node</h2>
        <div className="fd-segmented" role="radiogroup" aria-label="Type">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={kind === k ? 'active' : ''}
              disabled={!available(k)}
              title={available(k) ? AGENT_LABEL[k] : `${AGENT_LABEL[k]} CLI not found in PATH`}
              onClick={() => setKind(k)}
              data-testid={`kind-${k}`}
            >
              {AGENT_LABEL[k]}
            </button>
          ))}
        </div>
        {HINT[kind] && <p className="fd-hint">{HINT[kind]}</p>}
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
        <label>
          Working directory
          <span className="fd-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/you/project" required name="cwd" />
            <button type="button" className="fd-btn" onClick={() => void browse()}>
              Browse…
            </button>
          </span>
        </label>
        {accountAgent && (
          <label>
            Account
            <select value={accountId} onChange={(e) => setChosen({ ...chosen, [kind]: e.target.value })} name="account" required>
              <option value="" disabled>
                {kindAccounts.length ? 'Choose an account' : `Register a ${AGENT_LABEL[kind]} account first (Accounts)`}
              </option>
              {kindAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {a.configDir}
                </option>
              ))}
            </select>
          </label>
        )}
        {isAgentKind(kind) && (
          <>
            <label>
              Extra {AGENT_LABEL[kind]} arguments
              <input
                value={extra[kind] ?? ''}
                onChange={(e) => setExtra({ ...extra, [kind]: e.target.value })}
                placeholder={kind === 'codex' ? '-m <model>' : '--model <name>'}
                name="args"
              />
            </label>
            <label className="fd-check">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              Skip approval prompts ({SKIP_APPROVALS_FLAG[kind]}) — red ring; only other such nodes can send to it
            </label>
          </>
        )}
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
