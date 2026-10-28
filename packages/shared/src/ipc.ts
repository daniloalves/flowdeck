import type {
  Annotation,
  Account,
  AppSettings,
  AccountUsage,
  AppSnapshot,
  DiscoveredDir,
  Edge,
  Message,
  NodeTemplate,
  NodeView,
  QuickLaunchState,
  ScrollState,
  Viewport,
} from './model';
import type {
  AccountInput,
  AnnotationPatch,
  NewAnnotationInput,
  NewEdgeInput,
  NewNodeInput,
  NodePatch,
  QuickLaunchInput,
  SettingsPatch,
  TemplateInput,
  TemplateLaunchInput,
} from './schemas';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Request/response channels (renderer → main, `ipcRenderer.invoke`). */
export interface InvokeApi {
  'app:snapshot': () => AppSnapshot;
  'node:create': (input: NewNodeInput) => NodeView;
  'node:update': (id: string, patch: NodePatch) => NodeView;
  'node:delete': (id: string) => void;
  'node:restart': (id: string) => NodeView;
  'node:duplicate': (id: string) => NodeView;
  'edge:create': (input: NewEdgeInput) => Edge;
  'edge:delete': (id: string) => void;
  'annotation:create': (input: NewAnnotationInput) => Annotation;
  'annotation:update': (id: string, patch: AnnotationPatch) => Annotation;
  'annotation:delete': (id: string) => void;
  'template:create': (input: TemplateInput) => NodeTemplate;
  'template:update': (id: string, input: TemplateInput) => NodeTemplate;
  'template:delete': (id: string) => void;
  /** Launches a node from a template with its composed task (Launch panel). */
  'template:launch': (input: TemplateLaunchInput) => NodeView;
  'settings:update': (patch: SettingsPatch) => { settings: AppSettings; shortcutActive: boolean };
  /** Quick-launch window only: the text and templates to show (null when it is closed). */
  'quick:state': () => QuickLaunchState | null;
  /** Quick-launch window only. */
  'quick:launch': (input: QuickLaunchInput) => NodeView;
  /** Quick-launch window only: closes it. */
  'quick:close': () => void;
  'account:discover': () => DiscoveredDir[];
  'account:upsert': (input: AccountInput) => Account;
  'account:delete': (id: string) => void;
  'messages:list': () => Message[];
  'viewport:save': (viewport: Viewport) => void;
  'dialog:pickDirectory': () => string | null;
  'autostart:set': (enabled: boolean) => boolean;
  /** Scrollback position of a node's terminal; null when it cannot be read. */
  'pty:scrollState': (nodeId: string) => ScrollState | null;
}

export type InvokeChannel = keyof InvokeApi;

/** Fire-and-forget channels (renderer → main, `ipcRenderer.send`). */
export interface SendApi {
  'pty:open': { nodeId: string; cols: number; rows: number };
  'pty:input': { nodeId: string; data: string; exitScroll?: boolean };
  /** Scrolls a node's terminal to `lines` above the bottom (0 leaves scrollback). */
  'pty:scrollTo': { nodeId: string; lines: number };
  'pty:resize': { nodeId: string; cols: number; rows: number };
  'pty:close': { nodeId: string };
  'node:focus': { nodeId: string | null };
  /** Pastes the X11 PRIMARY selection or the clipboard into a node; main reads it, not the renderer. */
  'pty:paste': { nodeId: string; source: 'selection' | 'clipboard'; bracketed: boolean };
  /** Text selected in a terminal: sets both PRIMARY and the clipboard. */
  'clipboard:write': { text: string };
  /** A link Ctrl+clicked in a terminal; main opens it in the browser if it is an http(s) link. */
  'link:open': { url: string };
}

export type SendChannel = keyof SendApi;

/** Events pushed by main (main → renderer, `webContents.send`). */
export interface EventApi {
  'pty:data': { nodeId: string; data: string };
  'pty:exit': { nodeId: string };
  'node:changed': NodeView;
  'node:removed': { id: string };
  'edge:removed': { id: string };
  'usage:changed': AccountUsage[];
  'message:added': Message;
  'message:changed': Message;
  'ui:focusNode': { nodeId: string };
  /** A group grew to hold a node launched into it. */
  'annotation:changed': Annotation;
  /** Sent to the quick-launch window each time it opens. */
  'quick:show': QuickLaunchState;
}

export type EventChannel = keyof EventApi;

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:snapshot',
  'node:create',
  'node:update',
  'node:delete',
  'node:restart',
  'node:duplicate',
  'edge:create',
  'edge:delete',
  'annotation:create',
  'annotation:update',
  'annotation:delete',
  'template:create',
  'template:update',
  'template:delete',
  'template:launch',
  'settings:update',
  'quick:state',
  'quick:launch',
  'quick:close',
  'account:discover',
  'account:upsert',
  'account:delete',
  'messages:list',
  'viewport:save',
  'dialog:pickDirectory',
  'autostart:set',
  'pty:scrollState',
];

export const SEND_CHANNELS: readonly SendChannel[] = [
  'pty:open',
  'pty:input',
  'pty:resize',
  'pty:close',
  'node:focus',
  'pty:paste',
  'pty:scrollTo',
  'clipboard:write',
  'link:open',
];

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'pty:data',
  'pty:exit',
  'node:changed',
  'node:removed',
  'edge:removed',
  'usage:changed',
  'message:added',
  'message:changed',
  'ui:focusNode',
  'annotation:changed',
  'quick:show',
];

/** Channels only the quick-launch window may invoke; every other channel is the main window's. */
export const QUICK_CHANNELS: readonly InvokeChannel[] = ['quick:state', 'quick:launch', 'quick:close'];

/** API exposed on `window.flowdeck` by the preload script. */
export interface FlowDeckBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: Parameters<InvokeApi[C]>
  ): Promise<Result<ReturnType<InvokeApi[C]>>>;
  send<C extends SendChannel>(channel: C, payload: SendApi[C]): void;
  on<C extends EventChannel>(channel: C, listener: (payload: EventApi[C]) => void): () => void;
}
