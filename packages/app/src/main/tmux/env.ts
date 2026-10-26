import { STRIPPED_ENV_VARS } from '@flowdeck/shared';

/**
 * Environment for the tmux server and every node. Variables that would silently override the
 * account chosen on the canvas (API keys, config dir) are dropped by name; values are never read.
 */
export function sanitizeEnv(source: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const stripped = new Set<string>(STRIPPED_ENV_VARS);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || stripped.has(key)) continue;
    // Electron/Chromium internals and npm script context must not leak into user shells.
    if (key.startsWith('ELECTRON_') || key.startsWith('npm_') || key.startsWith('VITE_')) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return { ...env, ...overrides };
}
