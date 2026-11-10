import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOURS,
  dutyFor,
  fromClock,
  isOfficeOpen,
  parseHours,
  toClock,
} from './officeHours.js';

/** 2026-10-21 is a Wednesday; `hh:mm` on a clock `offsetMin` east of UTC. */
const at = (day: number, hh: number, mm: number, offsetMin = 0) =>
  Date.UTC(2026, 9, day, hh, mm) - offsetMin * 60_000;

describe('office hours (T-0041)', () => {
  it('opens at 09:00 and closes at 18:00 on a weekday', () => {
    expect(isOfficeOpen(DEFAULT_HOURS, at(21, 8, 59), 0)).toBe(false);
    expect(isOfficeOpen(DEFAULT_HOURS, at(21, 9, 0), 0)).toBe(true);
    expect(isOfficeOpen(DEFAULT_HOURS, at(21, 17, 59), 0)).toBe(true);
    expect(isOfficeOpen(DEFAULT_HOURS, at(21, 18, 0), 0)).toBe(false);
  });

  it('is closed all weekend', () => {
    expect(isOfficeOpen(DEFAULT_HOURS, at(24, 12, 0), 0)).toBe(false); // Saturday
    expect(isOfficeOpen(DEFAULT_HOURS, at(25, 12, 0), 0)).toBe(false); // Sunday
    expect(isOfficeOpen(DEFAULT_HOURS, at(26, 12, 0), 0)).toBe(true); // Monday
  });

  it("reads the host's clock, not this browser's", () => {
    const seoul = 9 * 60;
    // 09:30 in Seoul is 00:30 UTC: open on the host's clock, closed on UTC's.
    const t = at(21, 9, 30, seoul);
    expect(isOfficeOpen(DEFAULT_HOURS, t, seoul)).toBe(true);
    expect(isOfficeOpen(DEFAULT_HOURS, t, 0)).toBe(false);
    // Friday 20:00 UTC is Saturday 05:00 in Seoul.
    const late = { ...DEFAULT_HOURS, end: 23 * 60 };
    expect(isOfficeOpen(late, at(23, 20, 0), 0)).toBe(true);
    expect(isOfficeOpen(late, at(23, 20, 0), seoul)).toBe(false);
  });

  it('turned off, the office is always open', () => {
    const off = { ...DEFAULT_HOURS, on: false };
    expect(isOfficeOpen(off, at(21, 3, 0), 0)).toBe(true);
    expect(isOfficeOpen(off, at(25, 23, 0), 0)).toBe(true);
  });

  it('hours past midnight belong to the day they started on', () => {
    const night = { ...DEFAULT_HOURS, start: 22 * 60, end: 6 * 60 };
    expect(isOfficeOpen(night, at(21, 23, 0), 0)).toBe(true); // Wednesday night
    expect(isOfficeOpen(night, at(22, 5, 59), 0)).toBe(true); // Thursday morning
    expect(isOfficeOpen(night, at(25, 2, 0), 0)).toBe(false); // Sunday morning (Saturday off)
  });

  it('a working orchestrator after hours does overtime; an idle one goes home', () => {
    expect(dutyFor(true, false)).toBe('desk');
    expect(dutyFor(true, true)).toBe('desk');
    expect(dutyFor(false, true)).toBe('overtime');
    expect(dutyFor(false, false)).toBe('home');
  });

  it('keeps sane settings from storage', () => {
    expect(parseHours(null)).toEqual(DEFAULT_HOURS);
    expect(parseHours('junk')).toEqual(DEFAULT_HOURS);
    expect(parseHours('{"on":false,"start":600,"end":2000,"days":[6,0,9],"lingerMin":-1}')).toEqual(
      { ...DEFAULT_HOURS, on: false, start: 600, days: [0, 6] },
    );
    expect(toClock(9 * 60 + 5)).toBe('09:05');
    expect(fromClock('18:30')).toBe(18 * 60 + 30);
    expect(fromClock('25:00')).toBe(null);
  });
});
