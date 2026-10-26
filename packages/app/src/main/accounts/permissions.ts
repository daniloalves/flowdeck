import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Settings files that can set `permissions.defaultMode` for a node (credentials are never read). */
export function permissionSettingsFiles(configDir: string, cwd: string): string[] {
  return [
    '/etc/claude-code/managed-settings.json',
    join(configDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
}

/**
 * True when any settings file that applies to the node makes Claude Code skip permission
 * prompts by default. Such nodes are treated exactly like `--dangerously-skip-permissions`.
 */
export function settingsSkipPermissions(configDir: string, cwd: string): boolean {
  return permissionSettingsFiles(configDir, cwd).some((file) => {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: { defaultMode?: unknown } };
      return json.permissions?.defaultMode === 'bypassPermissions';
    } catch {
      return false;
    }
  });
}
