import type { NodeState } from '@flowdeck/shared';

/** One source of truth for what each colour means (node borders, bullets, legend). */
export const STATE_INFO: Record<NodeState, { label: string; meaning: string; order: number }> = {
  needs_input: { label: 'Needs you', meaning: 'Waiting for an approval or your input', order: 0 },
  working: { label: 'Working', meaning: 'The agent is busy on a turn', order: 1 },
  starting: { label: 'Starting', meaning: 'Launching, or waiting for the agent’s first signal', order: 2 },
  unknown: { label: 'Unknown', meaning: 'No signal yet from the agent', order: 3 },
  idle: { label: 'Idle', meaning: 'Finished its turn; ready for a prompt', order: 4 },
  dead: { label: 'Stopped', meaning: 'The process exited; use Resume', order: 5 },
};

export function Bullet({ state }: { state: NodeState }) {
  return <span className={`fd-bullet fd-bullet-${state}`} aria-label={STATE_INFO[state].label} />;
}

export function Legend() {
  const states = (Object.keys(STATE_INFO) as NodeState[]).sort((a, b) => STATE_INFO[a].order - STATE_INFO[b].order);
  return (
    <div className="fd-legend" data-testid="legend">
      {states.map((s) => (
        <div key={s} className="fd-legend-row">
          <Bullet state={s} />
          <strong>{STATE_INFO[s].label}</strong>
          <span className="fd-muted">{STATE_INFO[s].meaning}</span>
        </div>
      ))}
      <div className="fd-legend-row">
        <span className="fd-bullet fd-bullet-idle fd-bullet-danger" aria-label="Skips approvals" />
        <strong>Red ring</strong>
        <span className="fd-muted">Runs without approval prompts</span>
      </div>
      <div className="fd-legend-row fd-legend-wide">
        <span className="fd-tag">2 queued</span>
        <span className="fd-muted">Agent messages waiting for the node to be idle</span>
      </div>
    </div>
  );
}
