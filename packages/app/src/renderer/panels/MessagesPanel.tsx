import { useEffect } from 'react';
import { call } from '../api';
import { useStore } from '../store/store';

export function MessagesPanel() {
  const messages = useStore((s) => s.messages);
  const setMessages = useStore((s) => s.setMessages);

  useEffect(() => {
    call('messages:list').then(setMessages).catch(() => undefined);
  }, [setMessages]);

  return (
    <aside className="fd-panel" data-testid="messages-panel">
      <h2>Agent messages</h2>
      <p className="fd-muted">Every message sent between agents, newest first.</p>
      {messages.length === 0 && <p className="fd-muted">No messages yet. Connect two Claude nodes to let them talk.</p>}
      {messages.map((m) => (
        <div key={m.id} className="fd-card fd-message" data-testid="message-row">
          <div className="fd-row">
            <strong>{m.fromTitle}</strong>→<strong>{m.toTitle}</strong>
            <span className="fd-spacer" />
            <span className={m.delivered ? 'fd-ok' : 'fd-warn'}>
              {m.delivered ? (m.delivery === 'inbox' ? 'read via inbox' : m.delivery === 'pty' ? 'delivered' : 'discarded') : 'queued'}
            </span>
          </div>
          <div className="fd-muted">{new Date(m.createdAt).toLocaleString()}</div>
          <pre className="fd-message-body">{m.body}</pre>
        </div>
      ))}
    </aside>
  );
}
