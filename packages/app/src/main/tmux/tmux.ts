import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TMUX_SESSION_PREFIX, type ScrollState } from '@flowdeck/shared';

export interface TmuxOptions {
  /** tmux binary (default `tmux`). */
  bin: string;
  /** Socket name passed to `-L`. */
  socket: string;
  /** Config file applied when the server starts (`-f`). */
  confFile: string;
  /** Sanitised environment for the tmux server and its clients. */
  env: NodeJS.ProcessEnv;
}

export interface SessionSpec {
  name: string;
  cwd: string;
  /** Extra environment for this session only. */
  env: Record<string, string>;
  /** argv executed directly by tmux (no shell). */
  command: string[];
  cols?: number;
  rows?: number;
}

export interface PaneInfo {
  session: string;
  dead: boolean;
  pid: number;
  /** Last output in the window (ms since epoch, 1 s resolution), 0 if unknown. */
  activityAt: number;
}

/**
 * Runs argv[0] after closing every inherited file descriptor above stderr. Electron/Chromium
 * leaves many descriptors without CLOEXEC (profile locks, GPU caches, IPC sockets); the tmux
 * server must not keep them, since it outlives the app.
 */
export const CLOSE_FDS_AND_EXEC =
  'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null; done; exec "$@"';

const SESSION_NAME = new RegExp(`^${TMUX_SESSION_PREFIX}[A-Za-z0-9_-]{4,64}$`);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSessionName(name: string): void {
  if (!SESSION_NAME.test(name)) throw new Error(`invalid tmux session name: ${name}`);
}

/** Pure argv builder for `new-session`; exported for tests. */
export function buildNewSessionArgs(spec: SessionSpec): string[] {
  assertSessionName(spec.name);
  if (spec.command.length === 0) throw new Error('empty command');
  const args = ['new-session', '-d', '-s', spec.name, '-c', spec.cwd];
  if (spec.cols && spec.rows) args.push('-x', String(spec.cols), '-y', String(spec.rows));
  for (const [k, v] of Object.entries(spec.env)) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid environment variable name: ${k}`);
    if (v.includes('\0')) throw new Error(`invalid environment value for ${k}`);
    args.push('-e', `${k}=${v}`);
  }
  // With more than one argument tmux execs the command directly instead of through a shell.
  // A single-element command would be passed to `sh -c`, so pad it with an `exec` wrapper.
  const command = spec.command.length === 1 ? ['/usr/bin/env', spec.command[0]!] : spec.command;
  args.push('--', ...command);
  return args;
}

/** All tmux access goes through this class, always with `-L <socket>`. */
export class Tmux {
  private pasteQueue: Promise<void> = Promise.resolve();

  constructor(readonly opts: TmuxOptions) {}

  private base(): string[] {
    return ['-L', this.opts.socket, '-f', this.opts.confFile];
  }

  /**
   * @param startsServer the command may start the tmux server (only `new-session` here); it then
   *   runs through a shell that drops inherited descriptors first.
   */
  run(args: string[], input?: string, startsServer = false): Promise<{ stdout: string; stderr: string; code: number }> {
    const argv = [...this.base(), ...args];
    const [file, fileArgs] = startsServer
      ? ['/bin/bash', ['-c', CLOSE_FDS_AND_EXEC, 'flowdeck-tmux', this.opts.bin, ...argv]]
      : [this.opts.bin, argv];
    return new Promise((resolve, reject) => {
      const child = execFile(
        file,
        fileArgs,
        { env: this.opts.env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(`tmux not found (${this.opts.bin})`));
            return;
          }
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });
  }

  private async must(args: string[], input?: string, startsServer = false): Promise<string> {
    const r = await this.run(args, input, startsServer);
    if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.run(['-V']);
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    assertSessionName(name);
    // `=` forces an exact match instead of tmux's prefix matching.
    const r = await this.run(['has-session', '-t', `=${name}`]);
    return r.code === 0;
  }

  async newSession(spec: SessionSpec): Promise<void> {
    await this.must(buildNewSessionArgs(spec), undefined, true);
  }

  async killSession(name: string): Promise<void> {
    assertSessionName(name);
    await this.run(['kill-session', '-t', `=${name}`]);
  }

  /** All FlowDeck panes; [] when no server is running; null when tmux failed for another reason. */
  async listPanes(): Promise<PaneInfo[] | null> {
    const r = await this.run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}\t#{pane_pid}\t#{window_activity}']);
    if (r.code !== 0) {
      return /no server running|error connecting to/.test(r.stderr) ? [] : null;
    }
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [session = '', dead = '0', pid = '0', activity = '0'] = line.split('\t');
        return { session, dead: dead === '1', pid: Number(pid), activityAt: (Number(activity) || 0) * 1000 };
      })
      .filter((p) => p.session.startsWith(TMUX_SESSION_PREFIX));
  }

  async capture(name: string, lines = 200): Promise<string> {
    assertSessionName(name);
    return this.must(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', `=${name}:`]);
  }

  /**
   * Types `text` into the session as a bracketed paste (if the program enabled it) and presses
   * Enter. The text goes through a uniquely named tmux buffer read from stdin, never argv, and
   * pastes are serialised so two deliveries can never swap buffers.
   */
  pasteAndSubmit(name: string, text: string, enterDelayMs = 150): Promise<void> {
    assertSessionName(name);
    const run = async (): Promise<void> => {
      const buffer = `fd-msg-${randomUUID()}`;
      await this.must(['load-buffer', '-b', buffer, '-'], text);
      try {
        await this.must(['paste-buffer', '-p', '-d', '-b', buffer, '-t', `=${name}:`]);
      } catch (err) {
        await this.run(['delete-buffer', '-b', buffer]);
        throw err;
      }
      await new Promise((r) => setTimeout(r, enterDelayMs));
      await this.must(['send-keys', '-t', `=${name}:`, 'Enter']);
    };
    const next = this.pasteQueue.then(run, run);
    this.pasteQueue = next.catch(() => undefined);
    return next;
  }

  /** Scrollback position of the session's pane, or null if it cannot be read. */
  async scrollState(name: string): Promise<ScrollState | null> {
    assertSessionName(name);
    const r = await this.run([
      'display-message',
      '-p',
      '-t',
      `=${name}:`,
      '#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}',
    ]);
    if (r.code !== 0) return null;
    const [inMode = '0', position = '0', history = '0', rows = '0'] = r.stdout.trim().split('\t');
    return { inMode: inMode === '1', position: Number(position) || 0, history: Number(history) || 0, rows: Number(rows) || 0 };
  }

  /** Scrolls to `lines` above the bottom (copy mode without tmux's position indicator); 0 leaves it. */
  async scrollTo(name: string, lines: number): Promise<void> {
    assertSessionName(name);
    if (lines <= 0) return this.leaveScrollback(name);
    const t = `=${name}:`;
    await this.run(['copy-mode', '-eH', '-t', t, ';', 'send-keys', '-X', '-t', t, 'goto-line', String(Math.floor(lines))]);
  }

  /** Leaves copy mode, if the pane is in it (an error just means it was not). */
  async leaveScrollback(name: string): Promise<void> {
    assertSessionName(name);
    await this.run(['send-keys', '-X', '-t', `=${name}:`, 'cancel']);
  }

  /** Re-applies FlowDeck's config to a server started by an older version (no-op without a server). */
  async reloadConfig(): Promise<void> {
    await this.run(['source-file', this.opts.confFile]);
  }

  /** argv for an interactive client attached to `name` (used by the PTY bridge). */
  attachArgs(name: string): string[] {
    assertSessionName(name);
    return [...this.base(), 'attach-session', '-t', `=${name}`];
  }

  async killServer(): Promise<void> {
    await this.run(['kill-server']);
  }
}
