import type { AgentStateStore } from './agentStateStore.js';
import { PERMISSION_MODE_BYPASS } from './constants.js';
import { readTranscriptTail } from './contextUsage.js';
import { cancelPermissionTimer } from './timerManager.js';

/**
 * A session running with permissions bypassed can never wait on the user, so the
 * heuristic permission guess (a quiet non-exempt tool = "maybe a prompt") is
 * always a false positive for it, and for the sub-agents it spawns.
 *
 * Claude Code writes `{"type":"permission-mode","permissionMode":"..."}` records
 * to the transcript at session start and whenever the mode changes (shift+tab).
 */

/** Newest record wins. Switching to bypass drops a guess that is already showing. */
export function applyPermissionMode(
  agentId: number,
  agents: AgentStateStore,
  mode: unknown,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent || typeof mode !== 'string') return;
  agent.permissionMode = mode;
  if (mode !== PERMISSION_MODE_BYPASS) return;
  cancelPermissionTimer(agentId, permissionTimers);
  // Hooks mode shows real PermissionRequest state; only the guess is ours to clear.
  if (agent.permissionSent && !agent.hookDelivered) {
    agent.permissionSent = false;
    // The webview also clears the bubbles of this agent's sub-agents on this message.
    agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
  }
}

/** Seed `permissionMode` from the transcript tail when watching starts, so an agent
 *  adopted or restored mid-session does not guess before its next mode record. */
export function seedPermissionMode(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.permissionMode !== undefined || !agent.jsonlFile) return;
  const text = readTranscriptTail(agent.jsonlFile);
  if (text === null) return;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Cheap pre-filter: most tail lines are not mode records and can be large.
    if (!lines[i].includes('"permission-mode"')) continue;
    try {
      const record = JSON.parse(lines[i]);
      if (record.type === 'permission-mode' && typeof record.permissionMode === 'string') {
        agent.permissionMode = record.permissionMode;
        return;
      }
    } catch {
      // partial or malformed line
    }
  }
}
