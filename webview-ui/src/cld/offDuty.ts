/**
 * U-10 + U-27: an orchestrator that went home (퇴근) or is off has no character
 * to select, so a tap on its card did nothing. It opens this sheet instead:
 * what the office knows about it, and a way into its chat. A message to it goes
 * through the messenger, which already wakes a session Claude retired for
 * idleness (T-0123); once it works again the staff rules bring it back (야근).
 */
import { useSyncExternalStore } from 'react';

import type { EngineProject, OfficeJob, OfficeOrchestrator } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isOff } from './format.js';
import { modelEffortLabel } from './modelBadges.js';
import { serverLine } from './serverText.js';
import { staffSnapshot } from './staff.js';

let openId: number | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const emit = () => listeners.forEach((l) => l());

export const offDutyId = (): number | null => openId;
export const useOffDutyId = (): number | null => useSyncExternalStore(subscribe, offDutyId);
export function openOffDuty(agentId: number | null): void {
  if (openId === agentId) return;
  openId = agentId;
  emit();
}

/**
 * A card tap: select the character and follow it. One that is off duty (퇴근) opens its sheet
 * too, and the caller learns that no character was selected as it would be for one at work
 * (LOUNGE: it rests in the building now, so the camera goes to it as well).
 */
export function selectOrOpenInfo(os: OfficeState, id: number): boolean {
  const selected = os.selectAndFollow(id);
  if (staffSnapshot().away[id]) {
    openOffDuty(id);
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
  model: string | null;
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
    model: modelEffortLabel(project?.model, project?.effort),
    session: row.sessionId ? row.sessionId.slice(0, 8) : null,
    downNote: project?.downNote ? serverLine(project.downNote) : null,
    needsTrust: project?.needsTrust === true,
  };
}

/** The project's jobs, newest first. */
export const recentJobs = (jobs: OfficeJob[] | undefined, name: string, limit = 3): OfficeJob[] =>
  (jobs ?? [])
    .filter((job) => job.project === name)
    .sort((a, b) => Date.parse(b.started ?? '') - Date.parse(a.started ?? '') || 0)
    .slice(0, limit);
