import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const MARK = '__FLOWDECK_PATH__';

/**
 * Apps launched from a desktop menu get a minimal PATH. Ask the user's login shell for its PATH
 * once at start-up (only PATH is read), so nodes find `claude`, `node`, etc.
 */
export function loginShellPath(shell: string, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`],
      { timeout: timeoutMs, env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', TERM: 'dumb' } },
      (_err, stdout) => {
        const m = new RegExp(`${MARK}(.*?)${MARK}`).exec(String(stdout ?? ''));
        resolve(m?.[1] ? m[1] : null);
      },
    );
  });
}

export function mergePath(...paths: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  for (const p of paths) for (const dir of (p ?? '').split(delimiter)) if (dir) seen.add(dir);
  return [...seen].join(delimiter);
}

export function which(bin: string, path: string): string | null {
  if (bin.includes('/')) {
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
