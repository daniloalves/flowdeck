import type { AgentKind } from '@flowdeck/shared';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { kiroAdapter } from './kiro';
import type { AgentAdapter } from './types';

export const AGENTS: Record<AgentKind, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  kiro: kiroAdapter,
};

/** Environment variable that overrides an agent's executable (used by tests). */
export const binOverrideVar = (kind: AgentKind): string => `FLOWDECK_${kind.toUpperCase()}_BIN`;

export type { AgentAdapter, LaunchContext, LaunchPlan } from './types';
