import { AGENT_LABEL, SKIP_APPROVALS_FLAG, isAgentKind, type Account, type AccountAgent, type NodeKind } from '@flowdeck/shared';
import { call } from '../api';
import { useStore } from '../store/store';

export const KINDS: NodeKind[] = ['claude', 'codex', 'kiro', 'shell'];

/** Canvas size of a new node. */
export const DEFAULT_NODE_SIZE = { w: 720, h: 440 };

const HINT: Partial<Record<NodeKind, string>> = {
  codex:
    "The first Codex launch per account asks you to review FlowDeck's hooks: choose “Trust all and continue” (or run /hooks and press t) once, so status and messages work.",
  kiro: 'Kiro status comes from terminal activity (no “needs you” state). Kiro can receive messages but not send them yet.',
};

/** What a node launches with, as edited in a form. */
export interface LaunchConfig {
  kind: NodeKind;
  cwd: string;
  /** '' when the kind has no accounts or none is chosen. */
  accountId: string;
  /** Extra CLI arguments, space-separated. */
  extra: string;
  skip: boolean;
}

/** Agents whose nodes run under an account (Kiro has a single system login). */
export const accountAgentOf = (kind: NodeKind): AccountAgent | null => (kind === 'claude' || kind === 'codex' ? kind : null);

/** The preferred account if it still fits the kind, else the first account of that agent. */
export function pickAccount(kind: NodeKind, accounts: Account[], preferred?: string | null): string {
  const agent = accountAgentOf(kind);
  if (!agent) return '';
  const fitting = accounts.filter((a) => a.agent === agent);
  return fitting.find((a) => a.id === preferred)?.id ?? fitting[0]?.id ?? '';
}

export function toLaunchArgs(c: Pick<LaunchConfig, 'kind' | 'extra' | 'skip'>): string[] {
  if (!isAgentKind(c.kind)) return [];
  return [...c.extra.split(/\s+/).filter(Boolean), ...(c.skip ? [SKIP_APPROVALS_FLAG[c.kind]] : [])];
}

export function fromLaunchArgs(kind: NodeKind, args: readonly string[]): Pick<LaunchConfig, 'extra' | 'skip'> {
  const flag = isAgentKind(kind) ? SKIP_APPROVALS_FLAG[kind] : null;
  return { extra: args.filter((a) => a !== flag).join(' '), skip: flag !== null && args.includes(flag) };
}

export const isAvailable = (kind: NodeKind, agents: Partial<Record<NodeKind, string | null>> | undefined): boolean =>
  !isAgentKind(kind) || Boolean(agents?.[kind]);

/** Agent type picker and its hint. */
export function KindField({ kind, onChange }: { kind: NodeKind; onChange: (kind: NodeKind) => void }) {
  const env = useStore((s) => s.env);
  return (
    <>
      <div className="fd-segmented" role="radiogroup" aria-label="Type">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? 'active' : ''}
            disabled={!isAvailable(k, env?.agents)}
            title={isAvailable(k, env?.agents) ? AGENT_LABEL[k] : `${AGENT_LABEL[k]} CLI not found in PATH`}
            onClick={() => onChange(k)}
            data-testid={`kind-${k}`}
          >
            {AGENT_LABEL[k]}
          </button>
        ))}
      </div>
      {HINT[kind] && <p className="fd-hint">{HINT[kind]}</p>}
    </>
  );
}

/** Working directory, account, extra arguments and the skip-approvals switch. */
export function LaunchFields({ value, onChange }: { value: LaunchConfig; onChange: (patch: Partial<LaunchConfig>) => void }) {
  const accounts = useStore((s) => s.accounts);
  const { kind } = value;
  const accountAgent = accountAgentOf(kind);
  const kindAccounts = accounts.filter((a) => a.agent === accountAgent);

  const browse = async () => {
    const dir = await call('dialog:pickDirectory').catch(() => null);
    if (dir) onChange({ cwd: dir });
  };

  return (
    <>
      <label>
        Working directory
        <span className="fd-row">
          <input value={value.cwd} onChange={(e) => onChange({ cwd: e.target.value })} placeholder="/home/you/project" required name="cwd" />
          <button type="button" className="fd-btn" onClick={() => void browse()}>
            Browse…
          </button>
        </span>
      </label>
      {accountAgent && (
        <label>
          Account
          <select value={value.accountId} onChange={(e) => onChange({ accountId: e.target.value })} name="account" required>
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
              value={value.extra}
              onChange={(e) => onChange({ extra: e.target.value })}
              placeholder={kind === 'codex' ? '-m <model>' : '--model <name>'}
              name="args"
            />
          </label>
          <label className="fd-check">
            <input type="checkbox" checked={value.skip} onChange={(e) => onChange({ skip: e.target.checked })} name="skip" />
            Skip approval prompts ({SKIP_APPROVALS_FLAG[kind]}) — red ring; only other such nodes can send to it
          </label>
        </>
      )}
    </>
  );
}
