import { HOOK_EVENTS, type HookEvent, type HookPayload, type NodeState } from '@flowdeck/shared';

export interface Transition {
  /** New state, or null to keep the current one. */
  state: NodeState | null;
  detail: string | null;
  /** Claude session id to persist (SessionStart). */
  sessionId: string | null;
  /** Desktop notification to raise when the window is not focused. */
  notify: { title: string; body: string } | null;
  /** Deliver queued agent messages after applying the transition. */
  deliver: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isHookEvent = (name: string): name is HookEvent => (HOOK_EVENTS as readonly string[]).includes(name);

/** A session id we can safely pass back to an agent CLI (`--resume <id>`): any UUID version. */
export const validSessionId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

const keep = (): Transition => ({ state: null, detail: null, sessionId: null, notify: null, deliver: false });

/**
 * Maps a Claude Code hook event to a node state change. Pure, so the mapping is testable and
 * the only place to update if Claude Code's hook contract changes.
 */
export function transition(current: NodeState, event: HookEvent, payload: HookPayload, title: string): Transition {
  switch (event) {
    case 'SessionStart': {
      const id = validSessionId(payload.session_id);
      // `compact` can happen in the middle of a turn: keep the current state.
      if (payload.source === 'compact') return { ...keep(), sessionId: id };
      // No delivery here: a startup dialog may still be on screen. Queues drain on the first
      // Stop or idle reminder.
      return { ...keep(), state: 'idle', sessionId: id };
    }
    case 'UserPromptSubmit':
      return { ...keep(), state: 'working' };
    case 'PostToolUse':
      // A tool finished: if we were waiting on a permission, the user granted it.
      return current === 'working' ? keep() : { ...keep(), state: 'working' };
    case 'Stop':
      return {
        ...keep(),
        state: 'idle',
        notify: { title: `${title} finished`, body: 'Claude finished its turn.' },
        deliver: true,
      };
    case 'Notification': {
      const message = (payload.message ?? '').slice(0, 500) || 'Claude needs your attention';
      // The periodic "waiting for input" reminder is not a request for action.
      // It also recovers nodes stuck in "working" after the user interrupted with Esc (no Stop).
      if (payload.notification_type === 'idle_prompt') {
        return current === 'dead' ? keep() : { ...keep(), state: current === 'idle' ? null : 'idle', deliver: true };
      }
      return {
        ...keep(),
        state: 'needs_input',
        detail: message,
        notify: { title: `${title} needs input`, body: message },
      };
    }
    case 'PermissionRequest': {
      // Codex: about to ask for approval (shell escalation, network access...).
      const input = payload.tool_input as { description?: unknown } | undefined;
      const what = typeof input?.description === 'string' ? input.description : payload.tool_name;
      const message = (what ? `Approval needed: ${what}` : 'Approval needed').slice(0, 500);
      return { ...keep(), state: 'needs_input', detail: message, notify: { title: `${title} needs input`, body: message } };
    }
    case 'Interrupt':
      // The user pressed Esc: the turn is over without a Stop.
      return { ...keep(), state: current === 'dead' ? null : 'idle', deliver: true };
    case 'SessionEnd':
      // `/clear` ends a session and starts another one in the same process; real exits are
      // detected from the dead tmux pane, which is authoritative.
      return keep();
  }
}
