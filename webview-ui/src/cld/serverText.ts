/**
 * I1: the daemon's refusals and notices in the viewer's language. A reply carries
 * its Korean text (`error`) and a stable `errorCode` (+ `errorParams`); the code
 * picks this UI's own string, an unknown code falls back to the daemon's text.
 */
import {
  type Coded,
  isServerTextCode,
  matchKorean,
  type TextVars,
} from '../../../core/src/cld/serverText.js';
import type { TranslationKey } from '../i18n/en.js';
import { t } from '../i18n/index.js';

const LINE_MAX = 600;

export function codedText(code: string | undefined, params?: TextVars): string | undefined {
  if (!isServerTextCode(code)) return undefined;
  // A hole may hold another table text (a note built from a note).
  const own =
    params &&
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? serverLine(v) : v]),
    );
  return t(`srv.${code}` as TranslationKey, own);
}

/** The text of a reply's refusal (`error`, or `reason` for list items), in this language. */
export function serverText(m: Coded & { error?: string }, fallback = ''): string {
  return codedText(m.errorCode, m.errorParams) ?? (m.error ? serverLine(m.error) : fallback);
}

/** A bare string the daemon built from the table (a warning, a note, a label): same words, this language. */
/** Several lines the daemon joined with ' · ' (a note), each in this language. */
export function serverNote(text: string): string {
  const whole = matchKorean(text);
  return whole ? serverLine(text) : text.split(' · ').map(serverLine).join(' · ');
}

export function serverLine(text: string): string {
  if (text.length > LINE_MAX) return text; // a diff or a log is not a notice
  const hit = matchKorean(text);
  return hit ? (codedText(hit.code, hit.params) ?? text) : text;
}
