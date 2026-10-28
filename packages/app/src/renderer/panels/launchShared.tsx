import { composeTask } from '@flowdeck/shared';

/** Last template and group picked, per viewer; shared by the Launch panel and the quick-launch window. */
function remembered(key: string) {
  return {
    load(): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save(value: string | null): void {
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        /* storage unavailable: nothing to remember */
      }
    },
  };
}

export const lastTemplate = remembered('flowdeck.launch');
export const lastGroup = remembered('flowdeck.launchGroup');

/** The task that will be sent, when the template adds its own text around the user's. */
export function TaskPreview({ templateTask, text }: { templateTask: string; text: string }) {
  if (!templateTask.trim()) return null;
  return (
    <div className="fd-task-preview" data-testid="task-preview">
      <span className="fd-muted">Task sent (with the template's text)</span>
      <pre>{composeTask(templateTask, text)}</pre>
    </div>
  );
}

/** Optional group to launch the node into. */
export function GroupSelect({
  groups,
  value,
  onChange,
  testId,
}: {
  groups: { id: string; title: string }[];
  value: string;
  onChange: (id: string) => void;
  testId: string;
}) {
  return (
    <label>
      Group
      <select value={value} onChange={(e) => onChange(e.target.value)} name="group" data-testid={testId}>
        <option value="">No group</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </select>
    </label>
  );
}
