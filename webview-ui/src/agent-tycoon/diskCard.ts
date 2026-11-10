import { DISK_BYTES_PER_KIB, DISK_SIZE_UNITS } from '../constants.js';
import type { Language } from '../i18n/index.js';

/** Compact binary-byte display for the hardware page's disk card. */
export function diskBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  let unit = 0;
  let value = safe;
  while (value >= DISK_BYTES_PER_KIB && unit < DISK_SIZE_UNITS.length - 1) {
    value /= DISK_BYTES_PER_KIB;
    unit++;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${DISK_SIZE_UNITS[unit]}`;
}

/** The disk reading follows the app setting, not the browser's preferred language. */
export function diskMeasuredAt(measuredAt: string, language: Language): string {
  return new Date(measuredAt).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US');
}
