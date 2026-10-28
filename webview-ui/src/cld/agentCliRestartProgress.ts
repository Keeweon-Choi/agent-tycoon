import {
  AGENT_CLI_RESTART_EXPECTED_MS,
  AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT,
} from '../constants.js';

export type AgentCliRestartStage = 'closing' | 'starting' | 'engine';

/** The old daemon is still reachable until its socket closes; health proves the new engine is up. */
export function agentCliRestartStage(
  connectionDropped: boolean,
  engineReady: boolean,
): AgentCliRestartStage {
  if (engineReady) return 'engine';
  return connectionDropped ? 'starting' : 'closing';
}

/** Stops visibly short of completion when the restart outlasts its usual minute. */
export function agentCliRestartProgress(elapsedMs: number): number {
  return Math.min(
    AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT,
    Math.round((elapsedMs / AGENT_CLI_RESTART_EXPECTED_MS) * AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT),
  );
}

/** Keep this synchronous so the click becomes visibly busy before the daemon replies. */
export function requestAgentCliRecheck(send: () => void, setChecking: (checking: boolean) => void): void {
  setChecking(true);
  send();
}
