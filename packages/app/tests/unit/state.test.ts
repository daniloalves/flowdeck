import { describe, expect, it } from 'vitest';
import { isHookEvent, transition } from '../../src/main/events/state';

const SID = '0f5c4c1e-8a2b-4f7e-9d3c-2b1a0e9f8d7c';

describe('hook state machine', () => {
  it('SessionStart → idle and stores a valid session id, without typing into a possible startup dialog', () => {
    const t = transition('starting', 'SessionStart', { session_id: SID, source: 'startup' }, 'n');
    expect(t).toMatchObject({ state: 'idle', sessionId: SID, deliver: false, notify: null });
  });

  it('SessionStart from compaction keeps the current state (it can happen mid-turn)', () => {
    const t = transition('working', 'SessionStart', { session_id: SID, source: 'compact' }, 'n');
    expect(t).toMatchObject({ state: null, sessionId: SID, deliver: false });
  });

  it('ignores a malformed session id', () => {
    expect(transition('starting', 'SessionStart', { session_id: '../../etc' }, 'n').sessionId).toBeNull();
  });

  it('UserPromptSubmit → working', () => {
    expect(transition('idle', 'UserPromptSubmit', {}, 'n').state).toBe('working');
  });

  it('Stop → idle with a "finished" notification and delivery', () => {
    const t = transition('working', 'Stop', {}, 'Reviewer');
    expect(t.state).toBe('idle');
    expect(t.notify?.title).toBe('Reviewer finished');
    expect(t.deliver).toBe(true);
  });

  it('permission Notification → needs_input with the event text', () => {
    const t = transition('working', 'Notification', { message: 'Allow Bash?', notification_type: 'permission_prompt' }, 'n');
    expect(t).toMatchObject({ state: 'needs_input', detail: 'Allow Bash?' });
    expect(t.notify?.body).toBe('Allow Bash?');
  });

  it('idle_prompt reminder never flags the node, and recovers one stuck after an interrupt', () => {
    expect(transition('idle', 'Notification', { notification_type: 'idle_prompt' }, 'n')).toMatchObject({ state: null, notify: null });
    expect(transition('working', 'Notification', { notification_type: 'idle_prompt' }, 'n')).toMatchObject({ state: 'idle', deliver: true });
    expect(transition('dead', 'Notification', { notification_type: 'idle_prompt' }, 'n').state).toBeNull();
  });

  it('PostToolUse after a permission prompt → working', () => {
    expect(transition('needs_input', 'PostToolUse', {}, 'n').state).toBe('working');
    expect(transition('working', 'PostToolUse', {}, 'n').state).toBeNull();
  });

  it('SessionEnd never kills the node by itself (/clear restarts the session in place)', () => {
    expect(transition('idle', 'SessionEnd', { reason: 'clear' }, 'n').state).toBeNull();
  });

  it('truncates long notification text', () => {
    const t = transition('working', 'Notification', { message: 'x'.repeat(5000) }, 'n');
    expect(t.detail?.length).toBe(500);
  });

  it('recognises only known events', () => {
    expect(isHookEvent('Stop')).toBe(true);
    expect(isHookEvent('PreToolUse')).toBe(false);
    expect(isHookEvent('__proto__')).toBe(false);
  });
});
