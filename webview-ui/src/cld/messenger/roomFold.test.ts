import { describe, expect, it } from 'vitest';

import { foldThread, parseFold, unfoldThread, unseenReplies } from './roomFold.js';

describe('ROOM-FOLD: the fold state', () => {
  it('a fold remembers the count; replies after it are unseen until the thread is unfolded', () => {
    const s = foldThread({}, 't1', 2);
    expect(unseenReplies(s, 't1', 2)).toBe(0);
    expect(unseenReplies(s, 't1', 5)).toBe(3);
    expect(unseenReplies(s, 't2', 5)).toBe(0); // an open thread has nothing unseen
    expect(unseenReplies(unfoldThread(s, 't1'), 't1', 5)).toBe(0);
  });

  it('folding again takes the new count and keeps the others', () => {
    const s = foldThread(foldThread({}, 'a', 1), 'b', 2);
    expect(foldThread(s, 'a', 4)).toEqual({ b: 2, a: 4 });
    expect(unfoldThread(s, 'a')).toEqual({ b: 2 });
  });

  it('a stored value that is junk gives no folds', () => {
    expect(parseFold('{"a":2,"b":"x","c":-1}')).toEqual({ a: 2 });
    expect(parseFold('not json')).toEqual({});
    expect(parseFold('[1]')).toEqual({});
    expect(parseFold(null)).toEqual({});
  });
});
