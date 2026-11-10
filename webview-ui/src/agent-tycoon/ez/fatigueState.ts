/**
 * 피로도 (T-0026, T-0045), rule-based: exactly how full a character's context
 * is (contextTokens / maxContextTokens, as a percent). Compactions are counted
 * beside it ("압축 N/M"), not folded into it. The numbers are EZ rules data
 * (rules.ts FATIGUE, the user's ez-rules.json "fatigue"); this file only does
 * the arithmetic.
 */
import { RENEW_FILL_PCT } from '../../../../core/src/constants.js';
import type { CompactionRecord, ContextLimitBasis, EzFatigue } from '../../../../core/src/messages.js';
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
  /** Where `max` comes from. `unknown`: the token count is all there is, no percent. */
  basis: ContextLimitBasis;
}

/** The compactions the daemon counted in an agent's transcript (agentCompactions). */
export interface CompactionLog {
  count: number;
  /** A floor: the daemon began watching mid-session. */
  partial: boolean;
  /** The newest few, oldest first. */
  recent: CompactionRecord[];
}

export const contextPct = ({ tokens, max }: Pick<ContextSample, 'tokens' | 'max'>): number =>
  max > 0 ? (tokens / max) * 100 : 0;

/** The wire's `limitBasis`: a server that does not say sent an estimate (the old behaviour). */
export const basisOf = (limitBasis: ContextLimitBasis | undefined): ContextLimitBasis =>
  limitBasis ?? 'estimated';

/** Why a number is only roughly right, or undefined when it is not. */
export const basisHint = (basis: ContextLimitBasis): string | undefined =>
  basis === 'estimated' ? t('ctxsrc.estimatedHint') : basis === 'unknown' ? t('ctxsrc.unknownHint') : undefined;

/** The hover over the office gauge: the percent (≈ when estimated) with its tokens, or the token count alone. */
export function contextGaugeTitle(tokens: number, max: number, basis: ContextLimitBasis = 'estimated'): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const said =
    basis === 'unknown'
      ? t('ctxsrc.tokensOnly', { tokens: k(tokens) })
      : t('ctxsrc.gauge', {
          percent: contextPctText(Math.round(contextPct({ tokens, max })), basis),
          used: k(tokens),
          max: k(max),
        });
  return [said, basisHint(basis)].filter(Boolean).join('\n');
}

/** "≈80" for a percent measured against an estimated window, "80" otherwise. */
export const contextPctText = (value: number, basis: ContextLimitBasis): string =>
  basis === 'estimated' ? `≈${value}` : `${value}`;

export interface FatigueLook {
  /** 0..100: the context fill. */
  value: number;
  /** `estimated`: the window was picked from the model's name, so the percent is a guess (shown "≈"). */
  basis: ContextLimitBasis;
  compactions: number;
  /** The count is a floor: the daemon began watching mid-session and saw only the conversation's tail. */
  partial: boolean;
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
  basis: ContextLimitBasis = 'reported',
  partial = false,
): FatigueLook {
  const value = fatigueOf(contextPct);
  return {
    value,
    basis,
    compactions,
    partial,
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
export const compactionText = ({ compactions, partial, threshold }: FatigueLook): string =>
  t('activity.compactions', {
    count: `${partial ? '≥' : ''}${compactions}`,
    threshold: threshold === null ? '' : `/${threshold}`,
  });

/** The one line every surface shows: "피로도 80% · 압축 1/2". */
export const fatigueText = (look: FatigueLook): string =>
  t('activity.fatigueText', { percent: contextPctText(look.value, look.basis), compactions: compactionText(look) });
