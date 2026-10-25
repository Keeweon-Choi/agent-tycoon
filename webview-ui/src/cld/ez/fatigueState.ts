/**
 * 피로도 (T-0026, T-0045), rule-based: exactly how full a character's context
 * is (contextTokens / maxContextTokens, as a percent). Compactions are counted
 * beside it ("압축 N/M"), not folded into it. The numbers are EZ rules data
 * (rules.ts FATIGUE, the user's ez-rules.json "fatigue"); this file only does
 * the arithmetic.
 */
import { RENEW_FILL_PCT } from '../../../../core/src/constants.js';
import type { EzFatigue } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { FATIGUE } from './rules.js';

export type FatigueRules = Required<EzFatigue>;

/** The numbers in force: the user's over the defaults. */
export const fatigueRules = (user?: EzFatigue): FatigueRules =>
  user ? { ...FATIGUE, ...user } : FATIGUE;

/** fatigue = the context fill, clamped to 0..100, a whole number. */
export function fatigueOf(contextPct: number): number {
  const value = Math.round(contextPct);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** One agent's context as the office has seen it (agentContextUsage). */
export interface ContextSample {
  tokens: number;
  max: number;
  /** Drops of more than `compactionDrop` points: compactions, where nothing else counts them. */
  drops: number;
}

export const contextPct = ({ tokens, max }: ContextSample): number =>
  max > 0 ? (tokens / max) * 100 : 0;

/**
 * The next snapshot. A drop counts only when the tokens fell too: a window
 * that turns out wider lowers the percent without any compaction.
 */
export function nextContextSample(
  prev: ContextSample | undefined,
  tokens: number,
  max: number,
  rules = FATIGUE,
): ContextSample {
  const next: ContextSample = { tokens, max, drops: prev?.drops ?? 0 };
  if (prev && tokens < prev.tokens && contextPct(prev) - contextPct(next) > rules.compactionDrop) {
    next.drops += 1;
  }
  return next;
}

export interface FatigueLook {
  /** 0..100: the context fill. */
  value: number;
  compactions: number;
  /** M in "압축 N/M": compactions before the renew suggestion; null when nothing says. */
  threshold: number | null;
  /** The bar: green while fresh, yellow when tired, red from the yawns on. */
  tone: 'fresh' | 'tired' | 'worn';
  /** Sweat drops and a slower walk. */
  sweat: boolean;
  /** A yawn now and then. */
  yawn: boolean;
  /** The 휴식이 필요해요 bubble: the context fill alone (T-0047), a suggestion, never an action. */
  rest: boolean;
  /** Compactions have reached M and the context is RENEW_FILL_PCT full again (the engine's
   *  nudge, T-0116): "압축 N/M" is highlighted beside 인수인계 필요, no bubble. */
  renew: boolean;
}

export function fatigueLook(
  contextPct: number,
  compactions: number,
  rules = FATIGUE,
  threshold: number | null = null,
): FatigueLook {
  const value = fatigueOf(contextPct);
  return {
    value,
    compactions,
    threshold,
    tone: value >= rules.yawn ? 'worn' : value >= rules.tired ? 'tired' : 'fresh',
    sweat: value >= rules.tired,
    yawn: value >= rules.yawn,
    rest: value >= rules.rest,
    // The engine's renew nudge (T-0116): M compactions, then the context full again.
    renew: threshold !== null && compactions >= threshold && value >= RENEW_FILL_PCT,
  };
}

/** "압축 1/2" (or "압축 1" with no threshold). */
export const compactionText = ({ compactions, threshold }: FatigueLook): string =>
  t('activity.compactions', { count: compactions, threshold: threshold === null ? '' : `/${threshold}` });

/** The one line every surface shows: "피로도 80% · 압축 1/2". */
export const fatigueText = (look: FatigueLook): string =>
  t('activity.fatigueText', { percent: look.value, compactions: compactionText(look) });
