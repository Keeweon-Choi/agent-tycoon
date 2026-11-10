import { beforeEach, describe, expect, it } from 'vitest';

import { RANK_COLORS } from '../constants.js';
import { setLanguage } from '../i18n/index.js';
import { rankSprite } from './ez/rankSprites.js';
import { RANK_STYLES,rankHasStar, rankIndex, rankName, rankOfLevel } from './rank.js';
import { THEME } from './theme.js';

beforeEach(() => setLanguage('en'));

describe('rankOfLevel', () => {
  it('changes at the band edges, ten levels to a rank', () => {
    expect(rankOfLevel(1)).toBe('intern');
    expect(rankOfLevel(10)).toBe('intern');
    expect(rankOfLevel(11)).toBe('staff');
    expect(rankOfLevel(20)).toBe('staff');
    expect(rankOfLevel(21)).toBe('senior');
    expect(rankOfLevel(90)).toBe('managing');
    expect(rankOfLevel(91)).toBe('seniorManaging');
    expect(rankOfLevel(100)).toBe('seniorManaging');
    expect(rankOfLevel(101)).toBe('vicePresident');
    expect(rankOfLevel(5000)).toBe('vicePresident');
  });

  it('is none without a level, never guessed', () => {
    for (const level of [undefined, null, 0, -3, Number.NaN]) expect(rankOfLevel(level)).toBeNull();
  });

  it('has eleven ranks, each named in both languages', () => {
    expect(THEME.ranks).toHaveLength(11);
    setLanguage('en');
    expect(rankName('intern')).toBe('Intern');
    expect(rankName('vicePresident')).toBe('EVP');
    setLanguage('ko');
    expect(rankName('intern')).toBe('\uc778\ud134');
    expect(rankName('vicePresident')).toBe('\ubd80\uc0ac\uc7a5');
  });

  it('wears a star from the director up', () => {
    expect(THEME.ranks.filter((r) => rankHasStar(r.id)).map((r) => r.id)).toEqual([
      'director',
      'managing',
      'seniorManaging',
      'vicePresident',
    ]);
  });
});

describe('rankSprite', () => {
  it('draws every style for every rank, coloured by the rank along the ramp', () => {
    expect(RANK_COLORS.length).toBeGreaterThanOrEqual(THEME.ranks.length);
    for (const style of RANK_STYLES)
      for (const { id } of THEME.ranks) {
        const sprite = rankSprite(style, id);
        const colors = new Set(sprite.flat().filter(Boolean));
        expect(colors.has(RANK_COLORS[rankIndex(id)].main) || (style === 'tie' && id === 'intern')).toBe(true);
        expect(sprite.every((row) => row.length === sprite[0].length)).toBe(true);
      }
  });

  it('gives the tie an intern only the lanyard', () => {
    expect(rankSprite('tie', 'intern').length).toBeLessThan(rankSprite('tie', 'staff').length);
  });
});
