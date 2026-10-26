import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Account, AccountAgent, DiscoveredDir } from '@flowdeck/shared';

/** How an agent stores accounts: one config directory per account. */
export interface AccountSpec {
  agent: AccountAgent;
  /** `~/.claude` / `~/.codex`: the directory used when no override variable is set. */
  defaultDirName: string;
  /** Variable that selects another directory (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  dirVariable: string;
  /** File whose existence means "logged in". It is never opened. */
  credentialFile: string;
  /** Prefix of suggested ids (`codex-work`), empty for Claude (`work`). */
  idPrefix: string;
  /** Id suggested for the default directory. */
  defaultId: string;
}

export const CLAUDE_ACCOUNTS: AccountSpec = {
  agent: 'claude',
  defaultDirName: '.claude',
  dirVariable: 'CLAUDE_CONFIG_DIR',
  credentialFile: '.credentials.json',
  idPrefix: '',
  defaultId: 'default',
};

export const CODEX_ACCOUNTS: AccountSpec = {
  agent: 'codex',
  defaultDirName: '.codex',
  dirVariable: 'CODEX_HOME',
  credentialFile: 'auth.json',
  idPrefix: 'codex-',
  defaultId: 'codex',
};

export const ACCOUNT_SPECS: readonly AccountSpec[] = [CLAUDE_ACCOUNTS, CODEX_ACCOUNTS];

export const accountSpec = (agent: AccountAgent): AccountSpec =>
  ACCOUNT_SPECS.find((s) => s.agent === agent) ?? CLAUDE_ACCOUNTS;

const dirPattern = (spec: AccountSpec): RegExp =>
  new RegExp(`^${spec.defaultDirName.replace('.', '\\.')}(?:[-_.][A-Za-z0-9_-]+)?$`);

/** The directory the agent uses when its override variable is not set. */
export const defaultConfigDir = (home: string, spec: AccountSpec = CLAUDE_ACCOUNTS): string =>
  join(home, spec.defaultDirName);

export function suggestAccountId(configDir: string, home: string, spec: AccountSpec = CLAUDE_ACCOUNTS): string {
  if (resolve(configDir) === defaultConfigDir(home, spec)) return spec.defaultId;
  const slug = basename(configDir)
    .replace(new RegExp(`^${spec.defaultDirName.replace('.', '\\.')}[-_.]?`), '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 32 - spec.idPrefix.length);
  return slug ? `${spec.idPrefix}${slug}` : `${spec.idPrefix || 'account-'}${spec.agent}`;
}

/** Existence check only. FlowDeck never opens, reads or copies credential files. */
export function isLoggedIn(configDir: string, spec: AccountSpec = CLAUDE_ACCOUNTS): boolean {
  return existsSync(join(configDir, spec.credentialFile));
}

/** Lists `~/.claude*` and `~/.codex*` directories (files such as `~/.claude.json` are ignored). */
export function discoverConfigDirs(home: string, accounts: Account[]): DiscoveredDir[] {
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    entries = [];
  }
  const registered = new Map(accounts.map((a) => [resolve(a.configDir), a]));
  const found = new Map<string, AccountSpec>();
  for (const spec of ACCOUNT_SPECS) {
    const pattern = dirPattern(spec);
    for (const name of entries) {
      if (!pattern.test(name)) continue;
      const dir = join(home, name);
      try {
        if (statSync(dir).isDirectory()) found.set(dir, spec);
      } catch {
        /* broken link or permission problem: skip */
      }
    }
  }
  // Registered accounts outside $HOME are listed too.
  for (const a of accounts) found.set(resolve(a.configDir), accountSpec(a.agent));
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([configDir, spec]) => ({
      agent: registered.get(configDir)?.agent ?? spec.agent,
      configDir,
      suggestedId: suggestAccountId(configDir, home, spec),
      loggedIn: isLoggedIn(configDir, spec),
      registeredAs: registered.get(configDir)?.id ?? null,
    }));
}

/**
 * Environment that selects an account. The default directory must NOT set the variable: Claude
 * Code then also reads `~/.claude.json`, which holds onboarding and trust state.
 */
export function accountEnv(configDir: string, home: string, spec: AccountSpec = CLAUDE_ACCOUNTS): Record<string, string> {
  return resolve(configDir) === defaultConfigDir(home, spec) ? {} : { [spec.dirVariable]: resolve(configDir) };
}
