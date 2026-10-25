/**
 * The Korean words of a session's start / stop / restart buttons and their
 * confirmation question, and the particles after a name. Pure.
 */
import { getLanguage, t } from '../i18n/index.js';

export type SessionVerb = 'start' | 'quit' | 'restart';
export const ACTION_LABEL: Record<SessionVerb, string> = {
  get start() { return t('engine.action.start'); },
  get quit() { return t('engine.action.stop'); },
  get restart() { return t('engine.action.restart'); },
};

/** 을/를 after a name: Hangul by its final consonant; otherwise a guess from how it is read. */
export function objectParticle(name: string): string {
  if (getLanguage() !== 'ko') return '';
  const last = name.trim().slice(-1);
  const syllable = last.charCodeAt(0) - 0xac00;
  if (syllable >= 0 && syllable < 11172) return syllable % 28 ? '\uC744' : '\uB97C';
  return /[lmn0136789]$/i.test(last) ? '\uC744' : '\uB97C';
}

/** A name with the Korean subject particle, including a safe visible fallback. */
export function subjectWithParticle(name: string | null | undefined): string {
  const subject = name?.trim() || t('action.character');
  if (getLanguage() !== 'ko') return subject;
  const last = subject.slice(-1);
  const syllable = last.charCodeAt(0) - 0xac00;
  const hasFinalConsonant =
    (syllable >= 0 && syllable < 11172 && syllable % 28 !== 0) || /[lmnr013678]$/i.test(last);
  return `${subject}${hasFinalConsonant ? '\uC774' : '\uAC00'}`;
}

export function confirmText(
  action: SessionVerb,
  name: string,
): { question: string; note?: string } {
  const who = `${name}${objectParticle(name)}`;
  if (action === 'start') return { question: t('action.confirmStart', { name: who }) };
  if (action === 'quit') return { question: t('action.confirmQuit', { name: who }), note: t('action.quitNote') };
  return { question: t('action.confirmRestart', { name: who }), note: t('action.restartNote') };
}
