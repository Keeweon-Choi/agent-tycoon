/**
 * T-0041 office hours: a cosmetic clock for the office, never for the agents.
 * During hours the permanent staff sit at their desks; after hours an idle one
 * goes home and a working one stays on (야근). Read on the host's clock: the
 * daemon sends its UTC offset once (hostInfo.utcOffsetMin), so every client
 * agrees whatever its own time zone.
 *
 * The settings (on/off, hours, weekdays, how long a temp lingers) are per
 * browser, in localStorage behind try/catch: a blocked store keeps the defaults.
 */
import { useSyncExternalStore } from 'react';

import { t } from '../i18n/index.js';

export interface OfficeHours {
  on: boolean;
  /** Minutes after midnight, host time. */
  start: number;
  end: number;
  /** Working weekdays, 0 = Sunday. */
  days: number[];
  /** How long a temp lingers after its work, in minutes. */
  lingerMin: number;
}

export const DEFAULT_HOURS: OfficeHours = {
  on: true,
  start: 9 * 60,
  end: 18 * 60,
  days: [1, 2, 3, 4, 5],
  lingerMin: 10,
};

/** The weekday and minute of the day on a clock `offsetMin` east of UTC. */
export function hostTime(nowMs: number, offsetMin: number): { day: number; minute: number } {
  const d = new Date(nowMs + offsetMin * 60_000);
  return { day: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Whether the office is open. Off: always. Hours past midnight (22:00–06:00)
 * belong to the day they started on.
 */
export function isOfficeOpen(h: OfficeHours, nowMs: number, offsetMin: number): boolean {
  if (!h.on) return true;
  const { day, minute } = hostTime(nowMs, offsetMin);
  if (h.start <= h.end) return h.days.includes(day) && minute >= h.start && minute < h.end;
  return (
    (minute >= h.start && h.days.includes(day)) ||
    (minute < h.end && h.days.includes((day + 6) % 7))
  );
}

/** Where a permanent staff member belongs: at the desk during hours, on
 *  overtime when working after hours, else at home. */
export type Duty = 'desk' | 'overtime' | 'home';
export const dutyFor = (open: boolean, working: boolean): Duty =>
  open ? 'desk' : working ? 'overtime' : 'home';

/** What a card and the messenger say of an orchestrator besides its activity:
 *  gone home (퇴근), on overtime (야근, present after hours), or nothing. One rule for both. */
export type Presence = 'away' | 'overtime' | null;
export const presenceOf = (
  staff: { away: Record<number, unknown>; overtime: readonly number[] },
  id: number,
): Presence => (staff.away[id] ? 'away' : staff.overtime.includes(id) ? 'overtime' : null);

/** The word for a presence (the card's tag and the messenger's label). */
export const presenceWord = (p: NonNullable<Presence>): string =>
  t(p === 'away' ? 'temp.offDuty' : 'temp.overtime');

/** "HH:MM" for an <input type="time">, and back (null for junk). */
export const toClock = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export function fromClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const minuteOk = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24 * 60;

export function parseHours(raw: string | null): OfficeHours {
  let v: Partial<Record<keyof OfficeHours, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (parsed && typeof parsed === 'object') v = parsed as typeof v;
  } catch {
    /* junk: the defaults */
  }
  const days = Array.isArray(v.days)
    ? [...new Set(v.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d < 7))]
    : DEFAULT_HOURS.days;
  return {
    on: typeof v.on === 'boolean' ? v.on : DEFAULT_HOURS.on,
    start: minuteOk(v.start) ? v.start : DEFAULT_HOURS.start,
    end: minuteOk(v.end) ? v.end : DEFAULT_HOURS.end,
    days: days.sort(),
    lingerMin:
      typeof v.lingerMin === 'number' && v.lingerMin >= 0 && v.lingerMin <= 24 * 60
        ? v.lingerMin
        : DEFAULT_HOURS.lingerMin,
  };
}

// ── Store ────────────────────────────────────────────────────

export const HOURS_KEY = 'cld.office-hours';
function read(): OfficeHours {
  try {
    return parseHours(localStorage.getItem(HOURS_KEY));
  } catch {
    return DEFAULT_HOURS;
  }
}
let hours = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const officeHours = () => hours;
export const useOfficeHours = () => useSyncExternalStore(subscribe, officeHours);

export function setOfficeHours(next: Partial<OfficeHours>): void {
  hours = parseHours(JSON.stringify({ ...hours, ...next }));
  try {
    localStorage.setItem(HOURS_KEY, JSON.stringify(hours));
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  listeners.forEach((l) => l());
}

/** What a page load does: read the stored settings again (tests). */
export function reloadOfficeHours(): void {
  hours = read();
  listeners.forEach((l) => l());
}
