import { beforeEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../../i18n/index.js';
import {
  contextPct,
  type ContextSample,
  fatigueLook,
  fatigueOf,
  fatigueRules,
  fatigueText,
  nextContextSample,
} from './fatigueState.js';
import { FATIGUE } from './rules.js';

beforeEach(() => setLanguage('ko'));

/** Feed snapshots (tokens of a 200k window) through the drop counter. */
const feed = (tokens: number[], max = 200_000, rules = FATIGUE) =>
  tokens.reduce<ContextSample | undefined>(
    (prev, t) => nextContextSample(prev, t, max, rules),
    undefined,
  )!;

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
    expect(fatigueLook(contextPct({ tokens: 160_000, max: 200_000, drops: 0 }), 0).value).toBe(80);
    expect(fatigueLook(contextPct({ tokens: 160_000, max: 1_000_000, drops: 0 }), 0).value).toBe(
      16,
    );
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

describe('compactions from context drops (no office count)', () => {
  it('a drop of more than 40 points between snapshots is one compaction', () => {
    expect(feed([180_000, 20_000]).drops).toBe(1); // 90% -> 10%
    expect(feed([180_000, 20_000, 170_000, 30_000]).drops).toBe(2);
  });

  it('a drop of exactly 40 points, or a slow decline, is not', () => {
    expect(feed([100_000, 20_000]).drops).toBe(0); // 50% -> 10%: 40 points
    expect(feed([180_000, 140_000, 100_000, 60_000, 20_000]).drops).toBe(0);
  });

  it('a wider window lowers the percent without a compaction', () => {
    const before = nextContextSample(undefined, 180_000, 200_000);
    const wider = nextContextSample(before, 190_000, 1_000_000); // 90% -> 19%, tokens rose
    expect(contextPct(wider)).toBeCloseTo(19);
    expect(wider.drops).toBe(0);
  });

  it('takes the drop size from the rules', () => {
    expect(feed([100_000, 20_000], 200_000, fatigueRules({ compactionDrop: 30 })).drops).toBe(1);
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
