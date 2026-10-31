/**
 * The Korean words of a session's start / stop / restart buttons and their
 * confirmation question, and the particles after a name. Pure.
 */
import { JOSA, josa, withJosa } from '../../../core/src/cld/josa.js';
import { getLanguage, t } from '../i18n/index.js';

export type SessionVerb = 'start' | 'quit' | 'restart';
export const ACTION_LABEL: Record<SessionVerb, string> = {
  get start() { return t('engine.action.start'); },
  get quit() { return t('engine.action.stop'); },
  get restart() { return t('engine.action.restart'); },
};

/** 을/를 after a name, by how it is read (Hangul final consonant, digit or Latin letter). */
export function objectParticle(name: string): string {
  return getLanguage() === 'ko' ? josa(name, JOSA.object) : '';
}

/** A name with the Korean subject particle, including a safe visible fallback. */
export function subjectWithParticle(name: string | null | undefined): string {
  const subject = name?.trim() || t('action.character');
  return getLanguage() === 'ko' ? withJosa(subject, JOSA.subject) : subject;
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
