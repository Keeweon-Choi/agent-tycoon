/**
 * U-10: an orchestrator that went home (퇴근) or is off. It rests in the building (LOUNGE), so a card
 * tap focuses its character and its menu opens like any other's (owner 11-01 04:37); its 스탯 view
 * opens only when there is no character to select.
 */
import type { EngineProject, OfficeOrchestrator } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { openStatDetail } from './ez/statDetail.js';
import { isOff } from './format.js';
import { serverLine } from './serverText.js';
import { staffSnapshot } from './staff.js';

/**
 * A card tap: select the character and follow it (its menu opens). For one off duty (퇴근) the
 * caller learns that no character was selected as it would be for one at work, so it opens no
 * terminal; the 스탯 view opens only when its character could not be selected.
 */
export function selectOrOpenInfo(os: OfficeState, id: number): boolean {
  const selected = os.selectAndFollow(id);
  if (staffSnapshot().away[id]) {
    if (!selected) openStatDetail(id);
    return false;
  }
  return selected;
}

export interface OffDutyFacts {
  /** Gone home after hours; else just off. */
  away: boolean;
  off: boolean;
  room: string;
  folder: string | null;
  /** The session's id, first 8: the one a chat would resume. */
  session: string | null;
  /** The engine's own words when it gave up reviving the session. */
  downNote: string | null;
  needsTrust: boolean;
}

/** Only what the office really holds: an empty field is left out, never filled in. */
export function offDutyFacts(
  row: OfficeOrchestrator,
  project: EngineProject | undefined,
  away: boolean,
): OffDutyFacts {
  return {
    away,
    off: isOff(row),
    room: row.tab,
    folder: row.dir || null,
    session: row.sessionId ? row.sessionId.slice(0, 8) : null,
    downNote: project?.downNote ? serverLine(project.downNote) : null,
    needsTrust: project?.needsTrust === true,
  };
}
