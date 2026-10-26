import type { EventApi, EventChannel, InvokeApi, InvokeChannel } from '@flowdeck/shared';

/** Typed invoke that throws the main-process error message on failure. */
export async function call<C extends InvokeChannel>(
  channel: C,
  ...args: Parameters<InvokeApi[C]>
): Promise<Awaited<ReturnType<InvokeApi[C]>>> {
  const result = await window.flowdeck.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value as Awaited<ReturnType<InvokeApi[C]>>;
}

export const send = window.flowdeck.send.bind(window.flowdeck);

export function on<C extends EventChannel>(channel: C, listener: (payload: EventApi[C]) => void): () => void {
  return window.flowdeck.on(channel, listener);
}

/** One IPC listener for all terminals; each terminal registers by node id. */
type PtyHandler = { data: (data: string) => void; exit: () => void };
const ptyHandlers = new Map<string, PtyHandler>();
let ptyWired = false;

export function subscribePty(nodeId: string, handler: PtyHandler): () => void {
  if (!ptyWired) {
    ptyWired = true;
    on('pty:data', ({ nodeId: id, data }) => ptyHandlers.get(id)?.data(data));
    on('pty:exit', ({ nodeId: id }) => ptyHandlers.get(id)?.exit());
  }
  ptyHandlers.set(nodeId, handler);
  return () => {
    if (ptyHandlers.get(nodeId) === handler) ptyHandlers.delete(nodeId);
  };
}
