import { describe, expect, it } from 'vitest';

import { matchRanges, stepSearchResult } from './searchMatch.js';

describe('matchRanges', () => {
  it('finds every case-insensitive English and Korean match', () => {
    expect(matchRanges('Needle needle NEEDLE', 'needle')).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 13 },
      { start: 14, end: 20 },
    ]);
    expect(matchRanges('\uc0ac\uacfc\uc640 \uc0ac\uacfc', '\uc0ac\uacfc')).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });

  it('does not make ranges for an empty query', () => {
    expect(matchRanges('anything', '  ')).toEqual([]);
  });
});

describe('stepSearchResult', () => {
  it('steps and wraps across newest-first results', () => {
    expect(stepSearchResult(0, 3, 'older')).toBe(1);
    expect(stepSearchResult(2, 3, 'older')).toBe(0);
    expect(stepSearchResult(1, 3, 'newer')).toBe(0);
    expect(stepSearchResult(0, 3, 'newer')).toBe(2);
    expect(stepSearchResult(-1, 0, 'older')).toBe(-1);
  });
});
