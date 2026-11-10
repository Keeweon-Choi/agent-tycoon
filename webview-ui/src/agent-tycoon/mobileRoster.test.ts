import { describe, expect, it } from 'vitest';

import { MOBILE_ROSTER_STATES } from '../constants.js';
import { mobileRosterState, nextMobileRosterState, savedMobileRosterState } from './mobileRoster.js';

describe('mobile roster state', () => {
  it('cycles compact, expanded, and hidden through the single roster control', () => {
    expect(nextMobileRosterState(MOBILE_ROSTER_STATES.COMPACT)).toBe(MOBILE_ROSTER_STATES.EXPANDED);
    expect(nextMobileRosterState(MOBILE_ROSTER_STATES.EXPANDED)).toBe(MOBILE_ROSTER_STATES.HIDDEN);
    expect(nextMobileRosterState(MOBILE_ROSTER_STATES.HIDDEN)).toBe(MOBILE_ROSTER_STATES.COMPACT);
  });

  it('uses the saved state and migrates the previous full-card preference', () => {
    expect(mobileRosterState(MOBILE_ROSTER_STATES.HIDDEN, '1')).toBe(MOBILE_ROSTER_STATES.HIDDEN);
    expect(mobileRosterState(null, '1')).toBe(MOBILE_ROSTER_STATES.EXPANDED);
    expect(mobileRosterState(null, '0')).toBe(MOBILE_ROSTER_STATES.COMPACT);
    expect(savedMobileRosterState(MOBILE_ROSTER_STATES.COMPACT)).toBe('compact');
  });
});
