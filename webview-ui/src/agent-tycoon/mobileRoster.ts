import { MOBILE_ROSTER_STATES } from '../constants.js';

/** Presentation state of the phone's orchestrator roster. */
export type MobileRosterState = (typeof MOBILE_ROSTER_STATES)[keyof typeof MOBILE_ROSTER_STATES];

/** Read the current persisted value, retaining the former compact/full preference as a migration. */
export function mobileRosterState(
  saved: string | null,
  legacyExpanded: string | null,
): MobileRosterState {
  if (Object.values(MOBILE_ROSTER_STATES).includes(saved as MobileRosterState))
    return saved as MobileRosterState;
  return legacyExpanded === '1' ? MOBILE_ROSTER_STATES.EXPANDED : MOBILE_ROSTER_STATES.COMPACT;
}

/** The one control cycles compact -> full -> hidden -> compact. */
export function nextMobileRosterState(state: MobileRosterState): MobileRosterState {
  if (state === MOBILE_ROSTER_STATES.COMPACT) return MOBILE_ROSTER_STATES.EXPANDED;
  if (state === MOBILE_ROSTER_STATES.EXPANDED) return MOBILE_ROSTER_STATES.HIDDEN;
  return MOBILE_ROSTER_STATES.COMPACT;
}

/** The exact storage value, kept separate so storage failures leave the in-memory state usable. */
export const savedMobileRosterState = (state: MobileRosterState): string => state;
