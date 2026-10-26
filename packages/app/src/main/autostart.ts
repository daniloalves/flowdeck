import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const autostartFile = (home: string, xdgConfig?: string): string =>
  join(xdgConfig ?? join(home, '.config'), 'autostart', 'flowdeck.desktop');

const desktopQuote = (s: string): string => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;

export function desktopEntry(exec: string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=FlowDeck',
    'Comment=Canvas for Claude Code sessions',
    `Exec=${exec.map(desktopQuote).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function isAutostartEnabled(file: string): boolean {
  return existsSync(file);
}

export function setAutostart(file: string, enabled: boolean, exec: string[]): boolean {
  if (enabled) {
    // Do not change the permissions of the user's existing autostart directory.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, desktopEntry(exec), { mode: 0o644 });
  } else if (existsSync(file)) unlinkSync(file);
  return isAutostartEnabled(file);
}
