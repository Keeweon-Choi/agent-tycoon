import { beforeEach, describe, expect, it } from 'vitest';

import { setLanguage, t } from '../../i18n/index.js';
import { levelLook, levelText } from './level.js';

beforeEach(() => setLanguage('ko'));

const at = (xp: number) => ({ level: 2, xp, floor: 100, next: 300, rebirths: 1 });

describe('levelLook', () => {
  it('places the XP between the level floors', () => {
    expect(levelLook(at(100))).toEqual({ pct: 0, remaining: 200 });
    expect(levelLook(at(200))).toEqual({ pct: 50, remaining: 100 });
    expect(levelLook(at(299))).toEqual({ pct: 99, remaining: 1 });
  });

  it('never leaves the bar, even for a stale row', () => {
    expect(levelLook(at(50)).pct).toBe(0);
    expect(levelLook(at(900))).toEqual({ pct: 100, remaining: 0 });
  });
});

describe('levelText', () => {
  it('says Lv, rebirths and what is left, in the words of the legend', () => {
    expect(levelText(at(255))).toBe(
      [
        t('character.level', { level: 2 }),
        t('character.rebirths', { count: 1 }),
        t('character.xpToNext', { count: 45 }),
      ].join(' · '),
    );
  });
});
