import { DANGEROUS_FLAG, isAgentKind, type Edge, type EdgeDirection, type NodeRecord } from '@flowdeck/shared';

/** Does this node run without permission prompts? Provided by Core (flags + settings files). */
export type DangerCheck = (node: NodeRecord) => boolean;

const BYPASS_MODE = 'bypassPermissions';

/** Launch arguments that make Claude Code skip permission prompts, in any spelling. */
export function argsSkipPermissions(args: readonly string[]): boolean {
  return args.some((arg, i) => {
    if (arg === DANGEROUS_FLAG || arg === '--allow-dangerously-skip-permissions') return true;
    if (arg === `--permission-mode=${BYPASS_MODE}`) return true;
    return arg === '--permission-mode' && args[i + 1] === BYPASS_MODE;
  });
}

/** Can a message flow from `from` to `to` over this edge? */
export function edgeAllows(edge: Edge, from: string, to: string): boolean {
  if (edge.source === from && edge.target === to) return true;
  return edge.direction === 'both' && edge.source === to && edge.target === from;
}

export function findRoute(edges: Edge[], from: string, to: string): Edge | null {
  return edges.find((e) => edgeAllows(e, from, to)) ?? null;
}

/**
 * Messages may never flow from a node with permission prompts into a node that skips them:
 * a prompt-injected agent could otherwise escalate.
 */
export function escalationError(sender: NodeRecord, receiver: NodeRecord, dangerous: DangerCheck): string | null {
  if (dangerous(receiver) && !dangerous(sender)) {
    return `"${receiver.title}" skips permissions; it cannot receive messages from "${sender.title}", which does not`;
  }
  return null;
}

/** Returns an error message, or null when the edge is allowed. */
export function validateNewEdge(
  source: NodeRecord,
  target: NodeRecord,
  direction: EdgeDirection,
  existing: Edge[],
  dangerous: DangerCheck,
): string | null {
  if (source.id === target.id) return 'a node cannot be connected to itself';
  if (!isAgentKind(source.kind) || !isAgentKind(target.kind)) return 'only agent nodes (Claude, Codex, Kiro) can be connected';
  const duplicate = existing.some(
    (e) => (e.source === source.id && e.target === target.id) || (e.source === target.id && e.target === source.id),
  );
  if (duplicate) return 'these nodes are already connected';
  const forward = escalationError(source, target, dangerous);
  if (forward) return forward;
  if (direction === 'both') return escalationError(target, source, dangerous);
  return null;
}
