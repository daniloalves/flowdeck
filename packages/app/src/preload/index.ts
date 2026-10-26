import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type EventChannel,
  type FlowDeckBridge,
  type InvokeChannel,
  type SendChannel,
} from '@flowdeck/shared/ipc';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const sendAllowed = new Set<string>(SEND_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

/** The only API the renderer gets: allow-listed channels, no Node, no raw ipcRenderer. */
const bridge: FlowDeckBridge = {
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeAllowed.has(channel)) return Promise.resolve({ ok: false, error: 'unknown channel' });
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel: SendChannel, payload: unknown) {
    if (sendAllowed.has(channel)) ipcRenderer.send(channel, payload);
  },
  on(channel: EventChannel, listener: (payload: unknown) => void) {
    if (!eventAllowed.has(channel)) return () => undefined;
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
} as FlowDeckBridge;

contextBridge.exposeInMainWorld('flowdeck', bridge);
