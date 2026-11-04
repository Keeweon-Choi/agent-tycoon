import { beforeEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../../i18n/index.js';
import {
  basisOf,
  compactionText,
  contextGaugeTitle,
  contextPct,
  contextPctText,
  fatigueLook,
  fatigueOf,
  fatigueRules,
  fatigueText,
} from './fatigueState.js';
import { FATIGUE } from './rules.js';

beforeEach(() => setLanguage('ko'));

describe('fatigue formula (T-0045: exactly the context saturation)', () => {
  it.each([
    [0, 0],
    [20, 20],
    [72.4, 72],
    [72.5, 73],
    [100, 100],
    [150, 100],
    [-5, 0],
    [Number.NaN, 0],
  ])('context %s%% is a fatigue of %s', (pct, want) => {
    expect(fatigueOf(pct)).toBe(want);
  });

  it('compactions never change it', () => {
    expect(fatigueLook(40, 0).value).toBe(40);
    expect(fatigueLook(40, 5).value).toBe(40);
  });

  it('is contextTokens / maxContextTokens as a percent', () => {
    expect(fatigueLook(contextPct({ tokens: 160_000, max: 200_000 }), 0).value).toBe(80);
    expect(fatigueLook(contextPct({ tokens: 160_000, max: 1_000_000 }), 0).value).toBe(16);
  });
});

describe('the fatigue line: \ud53c\ub85c\ub3c4 N% · \ud734\uc2dd N/M', () => {
  const text = (pct: number, n: number, m: number | null) =>
    fatigueText(fatigueLook(pct, n, FATIGUE, m));
  it('shows the threshold when there is one', () => {
    expect(text(80, 1, 2)).toBe('\ud53c\ub85c\ub3c4 80% · \ud734\uc2dd 1/2');
    expect(text(0, 0, 3)).toBe('\ud53c\ub85c\ub3c4 0% · \ud734\uc2dd 0/3');
  });
  it('shows just the count without one', () => {
    expect(text(80, 1, null)).toBe('\ud53c\ub85c\ub3c4 80% · \ud734\uc2dd 1');
  });
});

describe('where the limit comes from (FR-STA-005)', () => {
  it('says nothing on a reported limit and "≈" on an estimated one', () => {
    expect(contextPctText(80, 'reported')).toBe('80');
    expect(contextPctText(80, 'estimated')).toBe('≈80');
    expect(fatigueText(fatigueLook(80, 1, FATIGUE, 2, 'estimated'))).toBe(
      '\ud53c\ub85c\ub3c4 ≈80% · \ud734\uc2dd 1/2',
    );
    expect(fatigueText(fatigueLook(80, 1, FATIGUE, 2, 'reported'))).toBe(
      '\ud53c\ub85c\ub3c4 80% · \ud734\uc2dd 1/2',
    );
  });

  it('a server that names no basis sent an estimate; the default look claims none', () => {
    expect(basisOf(undefined)).toBe('estimated');
    expect(basisOf('reported')).toBe('reported');
    expect(fatigueLook(10, 0).basis).toBe('reported');
  });

  it('the gauge hover has ≈ and the reason for an estimate, tokens only for an unknown window', () => {
    expect(contextGaugeTitle(250_000, 1_000_000, 'estimated')).toBe(
      '\ucee8\ud14d\uc2a4\ud2b8 ≈25% \uc0ac\uc6a9 (250k / 1000k \ud1a0\ud070)\n\ucd94\uc815: \ubaa8\ub378 \uc774\ub984\uc73c\ub85c \ud55c\ub3c4\ub97c \uace8\ub790\uc5b4\uc694',
    );
    expect(contextGaugeTitle(250_000, 1_000_000, 'reported')).toBe(
      '\ucee8\ud14d\uc2a4\ud2b8 25% \uc0ac\uc6a9 (250k / 1000k \ud1a0\ud070)',
    );
    const unknown = contextGaugeTitle(52_000, 200_000, 'unknown');
    expect(unknown).toContain('52k \ud1a0\ud070 · \ud55c\ub3c4 \ubaa8\ub984');
    expect(unknown).not.toContain('%');
  });
});

describe('the rest count from the daemon', () => {
  it('a partial count reads as a floor', () => {
    expect(compactionText(fatigueLook(10, 2, FATIGUE, null, 'reported', true))).toBe(
      '\ud734\uc2dd ≥2',
    );
    expect(compactionText(fatigueLook(10, 2, FATIGUE, 3, 'reported', false))).toBe(
      '\ud734\uc2dd 2/3',
    );
  });
});

describe('fatigue thresholds', () => {
  it.each([
    [59, 'fresh', false, false, false],
    [60, 'tired', true, false, false],
    [69, 'tired', true, false, false],
    [70, 'worn', true, true, false],
    [79, 'worn', true, true, false],
    [80, 'worn', true, true, true],
  ] as const)('%s%%: %s bar, sweat %s, yawn %s, rest %s', (pct, tone, sweat, yawn, rest) => {
    expect(fatigueLook(pct, 0)).toMatchObject({ value: pct, tone, sweat, yawn, rest });
  });

  it('the rest bubble is the context alone: 79/80% with 0/2 compactions (T-0047)', () => {
    for (const compactions of [0, 2]) {
      expect(fatigueLook(79, compactions, FATIGUE, 2).rest).toBe(false);
      expect(fatigueLook(80, compactions, FATIGUE, 2).rest).toBe(true);
    }
    // Reaching M never raises it, however low the context.
    expect(fatigueLook(5, 2, FATIGUE, 2)).toMatchObject({ rest: false, renew: false });
  });

  it('"\ud734\uc2dd N/M" is highlighted when the engine nudges: M compactions, then 85% full again (T-0116)', () => {
    expect(fatigueLook(90, 1, FATIGUE, 2).renew).toBe(false);
    // Right after the M-th compaction the context is nearly empty: not due yet (10-22 18:31).
    expect(fatigueLook(5, 2, FATIGUE, 2).renew).toBe(false);
    expect(fatigueLook(84, 2, FATIGUE, 2).renew).toBe(false);
    expect(fatigueLook(85, 2, FATIGUE, 2).renew).toBe(true);
    expect(fatigueLook(95, 9, FATIGUE, null).renew).toBe(false);
  });

  it('follows the user numbers (ez-rules.json "fatigue")', () => {
    const rules = fatigueRules({ tired: 50, yawn: 60, rest: 70 });
    expect(fatigueLook(55, 0, rules)).toMatchObject({ tone: 'tired', sweat: true, yawn: false });
    expect(fatigueLook(70, 0, rules).rest).toBe(true);
    expect(fatigueRules()).toBe(FATIGUE);
  });

  it('keeps the defaults in the rules data: the rest line', () => {
    expect(FATIGUE.rest).toBe(80);
  });
});
