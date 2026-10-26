import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeRecord } from '@flowdeck/shared';

export type ClaudeStart =
  | { mode: 'new'; sessionId: string }
  | { mode: 'resume'; sessionId: string }
  | { mode: 'continue' };

/**
 * How to (re)start a Claude node whose tmux session does not exist.
 * - known id with a transcript on disk: `--resume <id>`;
 * - known id without a transcript (no prompt was ever sent): start with the same `--session-id`,
 *   because `--resume` would fail;
 * - unknown id (legacy row): `--continue` only if no other Claude node shares cwd + account,
 *   because `--continue` picks the most recent conversation of the directory; otherwise a new
 *   FlowDeck-assigned id.
 * New nodes always get a FlowDeck-assigned id before their first launch.
 */
export function planClaudeStart(
  node: Pick<NodeRecord, 'id' | 'kind' | 'cwd' | 'accountId' | 'sessionId'>,
  others: Pick<NodeRecord, 'id' | 'kind' | 'cwd' | 'accountId'>[],
  hasTranscript: (sessionId: string) => boolean,
  newId: () => string,
): ClaudeStart {
  if (node.sessionId) {
    return hasTranscript(node.sessionId)
      ? { mode: 'resume', sessionId: node.sessionId }
      : { mode: 'new', sessionId: node.sessionId };
  }
  return sharesWorkspace(node, others) ? { mode: 'new', sessionId: newId() } : { mode: 'continue' };
}

/**
 * Does another node of the same agent use the same directory and account? Then "continue the
 * most recent conversation of this directory" could pick that node's conversation.
 */
export function sharesWorkspace(
  node: Pick<NodeRecord, 'id' | 'kind' | 'cwd' | 'accountId'>,
  others: Pick<NodeRecord, 'id' | 'kind' | 'cwd' | 'accountId'>[],
): boolean {
  return others.some(
    (o) => o.id !== node.id && o.kind === node.kind && o.cwd === node.cwd && o.accountId === node.accountId,
  );
}

export function claudeStartArgs(start: ClaudeStart): string[] {
  switch (start.mode) {
    case 'new':
      return ['--session-id', start.sessionId];
    case 'resume':
      return ['--resume', start.sessionId];
    case 'continue':
      return ['--continue'];
  }
}

/** Does `<configDir>/projects/<any project>/<sessionId>.jsonl` exist? Names only; nothing is read. */
export function transcriptExists(configDir: string, sessionId: string): boolean {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false;
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}
