/**
 * BACKGROUND clock: whether the sky is day, by the setting and the host's clock (the daemon sends
 * its UTC offset once, so every screen agrees whatever its own time zone). Pure.
 */
import type { BackgroundTime } from '../../../../../core/src/messages.js';
import { BG_DAY_END_HOUR, BG_DAY_START_HOUR } from '../../../constants.js';
import { hostTime } from '../../officeHours.js';

/** True from BG_DAY_START_HOUR (inclusive) to BG_DAY_END_HOUR (exclusive) on the host's clock. */
export function isDayAt(nowMs: number, offsetMin: number): boolean {
  const hour = hostTime(nowMs, offsetMin).minute / 60;
  return hour >= BG_DAY_START_HOUR && hour < BG_DAY_END_HOUR;
}

/** Whether the sky is night under `time` at `nowMs` (the host's clock is `offsetMin` east of UTC). */
export function isNight(time: BackgroundTime, nowMs: number, offsetMin: number): boolean {
  return time === 'night' || (time === 'clock' && !isDayAt(nowMs, offsetMin));
}
