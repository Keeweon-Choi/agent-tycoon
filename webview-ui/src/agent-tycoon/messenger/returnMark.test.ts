import { describe, expect, it } from 'vitest';

import { idTime, isNearMark, markOf } from './returnMark.js';

const rows = [
  { id: '100-a', offsetTop: 0, offsetHeight: 50 },
  { id: '200-b', offsetTop: 50, offsetHeight: 80 },
  { id: '300-c', offsetTop: 130, offsetHeight: 40 },
];

describe('returnMark', () => {
  it('marks the first row still in view with its offset', () => {
    expect(markOf(rows, 60, false)).toEqual({ id: '200-b', at: 200, top: -10 });
  });
  it('marks the bottom without a row', () => {
    expect(markOf(rows, 60, true)).toEqual({ id: null, at: 0, top: 0 });
  });
  it('has no mark in an empty list', () => {
    expect(markOf([], 0, false)).toBeNull();
  });
  it('reads the time from an item id', () => {
    expect(idTime('1700-uuid-x')).toBe(1700);
  });
  it('counts within half a screen as near, either side', () => {
    expect(isNearMark(100, 400)).toBe(true);
    expect(isNearMark(-199, 400)).toBe(true);
    expect(isNearMark(200, 400)).toBe(false);
    expect(isNearMark(-900, 400)).toBe(false);
  });
});
