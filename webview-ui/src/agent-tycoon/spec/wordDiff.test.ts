import { describe, expect, it } from 'vitest';

import { wordDiff } from './wordDiff.js';

describe('wordDiff', () => {
  it('marks the words gone from the old text and the words new in the current one', () => {
    const d = wordDiff('lock the account for 15 minutes', 'lock the account for 20 minutes');
    expect(d.old.filter((p) => p.changed).map((p) => p.text)).toEqual(['15']);
    expect(d.now.filter((p) => p.changed).map((p) => p.text)).toEqual(['20']);
    expect(d.now.map((p) => p.text).join('')).toBe('lock the account for 20 minutes');
    expect(d.old.map((p) => p.text).join('')).toBe('lock the account for 15 minutes');
  });
  it('gives up on huge texts, marking nothing', () => {
    const big = 'a '.repeat(2000);
    expect(wordDiff(big, `${big}b`).now).toEqual([{ text: `${big}b`, changed: false }]);
  });
});
