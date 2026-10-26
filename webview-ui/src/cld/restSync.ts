import type { OfficeState } from '../office/engine/officeState.js';

/**
 * REST-BUSY: an orchestrator without a live agent (resting or off) has a
 * character made by the office snapshot alone, and no agentStatus ever
 * reaches it, so createCharacter's `isActive: true` stayed for good: the
 * owner could not walk or move it ("working at its desk"). Its activity is
 * what the snapshot row says (`busy`); a character on its way home or gone
 * (cldAway) is staff.ts's to keep.
 */
export function syncUnattachedActive(
  os: Pick<OfficeState, 'characters' | 'setAgentActive'>,
  rows: Array<{ id: number; busy: boolean | null }>,
): void {
  for (const { id, busy } of rows) {
    const ch = os.characters.get(id);
    if (!ch || ch.cldAway || ch.isActive === (busy === true)) continue;
    os.setAgentActive(id, busy === true);
  }
}
