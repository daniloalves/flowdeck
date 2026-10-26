import { useEffect, useState } from 'react';
import { AGENT_LABEL, type Account, type AccountAgent, type DiscoveredDir } from '@flowdeck/shared';
import { call } from '../api';
import { formatTokens, useStore } from '../store/store';

const COLORS = ['#7c6cf2', '#f2a33c', '#3cb4f2', '#4fc47a', '#e25d8a', '#c9c94a'];

interface Draft {
  id: string;
  agent: AccountAgent;
  label: string;
  configDir: string;
  color: string;
  cap5h: string;
  cap7d: string;
  existing: boolean;
}

const toCap = (v: string): number | null => {
  const n = Number(v.replace(/[_,\s]/g, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
};

function draftFrom(dir: DiscoveredDir, account: Account | undefined, index: number): Draft {
  return account
    ? {
        id: account.id,
        agent: account.agent,
        label: account.label,
        configDir: account.configDir,
        color: account.color,
        cap5h: account.cap5h ? String(account.cap5h) : '',
        cap7d: account.cap7d ? String(account.cap7d) : '',
        existing: true,
      }
    : {
        id: dir.suggestedId,
        agent: dir.agent,
        label: dir.suggestedId,
        configDir: dir.configDir,
        color: COLORS[index % COLORS.length]!,
        cap5h: '',
        cap7d: '',
        existing: false,
      };
}

export function AccountsPanel({ onLogin }: { onLogin: (account: Account) => void }) {
  const accounts = useStore((s) => s.accounts);
  const usage = useStore((s) => s.usage);
  const setAccounts = useStore((s) => s.setAccounts);
  const toast = useStore((s) => s.toast);
  const [dirs, setDirs] = useState<DiscoveredDir[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = () => call('account:discover').then(setDirs).catch((e: Error) => toast('error', e.message));
  useEffect(() => void refresh(), [accounts]);

  const save = async () => {
    if (!draft) return;
    try {
      await call('account:upsert', {
        id: draft.id,
        agent: draft.agent,
        label: draft.label,
        configDir: draft.configDir,
        color: draft.color,
        cap5h: toCap(draft.cap5h),
        cap7d: toCap(draft.cap7d),
      });
      setAccounts((await call('app:snapshot')).accounts);
      setDraft(null);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await call('account:delete', id);
      setAccounts(accounts.filter((a) => a.id !== id));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <aside className="fd-panel" data-testid="accounts-panel">
      <h2>Accounts</h2>
      <p className="fd-muted">
        An account is a config directory: <code>~/.claude*</code> for Claude Code, <code>~/.codex*</code> for Codex
        (create one with <code>mkdir ~/.codex-work</code>). Kiro uses its single system login. FlowDeck never reads
        credentials; it only checks whether you are logged in.
      </p>
      {dirs.map((dir, i) => {
        const account = accounts.find((a) => a.id === dir.registeredAs);
        const u = account ? usage[account.id] : undefined;
        return (
          <div key={dir.configDir} className="fd-card">
            <div className="fd-row">
              {account && <span className="fd-badge-dot" style={{ background: account.color }} />}
              <strong>{account?.label ?? dir.configDir.split('/').pop()}</strong>
              <span className={`fd-kind fd-kind-${dir.agent}`}>{AGENT_LABEL[dir.agent]}</span>
              <span className={dir.loggedIn ? 'fd-ok' : 'fd-warn'}>{dir.loggedIn ? 'logged in' : 'not logged in'}</span>
            </div>
            <div className="fd-muted fd-mono">{dir.configDir}</div>
            {account && u && (
              <div className="fd-muted">
                5 h block: {formatTokens(u.block ? u.block.inputTokens + u.block.outputTokens : 0)}
                {account.cap5h ? ` / ${formatTokens(account.cap5h)}` : ''} · 7 days:{' '}
                {formatTokens(u.week.inputTokens + u.week.outputTokens)}
                {account.cap7d ? ` / ${formatTokens(account.cap7d)}` : ''}
              </div>
            )}
            <div className="fd-row">
              <button className="fd-btn" onClick={() => setDraft(draftFrom(dir, account, i))}>
                {account ? 'Edit' : 'Register'}
              </button>
              {account && (
                <>
                  <button className="fd-btn" onClick={() => onLogin(account)}>
                    Open login node
                  </button>
                  <button className="fd-btn fd-btn-danger" onClick={() => void remove(account.id)}>
                    Remove
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {dirs.length === 0 && <p className="fd-muted">No ~/.claude* directories found. Create one, e.g. mkdir ~/.claude-work.</p>}

      {draft && (
        <div className="fd-card fd-form">
          <h3>{draft.existing ? 'Edit account' : 'Register account'}</h3>
          <label>
            Id
            <input value={draft.id} disabled={draft.existing} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          </label>
          <label>
            Label
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </label>
          <label>
            Colour
            <input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
          </label>
          <label>
            5 h token cap (optional)
            <input value={draft.cap5h} inputMode="numeric" onChange={(e) => setDraft({ ...draft, cap5h: e.target.value })} />
          </label>
          <label>
            7 day token cap (optional)
            <input value={draft.cap7d} inputMode="numeric" onChange={(e) => setDraft({ ...draft, cap7d: e.target.value })} />
          </label>
          <div className="fd-actions">
            <button className="fd-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="fd-btn fd-btn-primary" onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
