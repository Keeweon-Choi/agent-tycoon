import { describe, expect, it } from 'vitest';

import { isHidden, mayFetchOlder, restoreTop } from './scrollRestore.js';

const size = { scrollHeight: 3000, clientHeight: 500 };

describe('conversation scroll restoration', () => {
  it('returns a reader that followed the bottom to the bottom', () => {
    expect(
      restoreTop({ stuck: true, anchorTop: null, rowOffsetTop: null, savedTop: 0 }, size),
    ).toBe(2500);
  });

  it('returns an away reader to its anchored row', () => {
    expect(
      restoreTop({ stuck: false, anchorTop: 40, rowOffsetTop: 880, savedTop: 500 }, size),
    ).toBe(840);
  });

  it('keeps an unanchored away reader at its saved top', () => {
    expect(
      restoreTop({ stuck: false, anchorTop: null, rowOffsetTop: null, savedTop: 420 }, size),
    ).toBe(420);
  });

  it('recognises a hidden or detached list', () => {
    expect(isHidden({ clientHeight: 0, isConnected: true })).toBe(true);
    expect(isHidden({ clientHeight: 500, isConnected: false })).toBe(true);
    expect(isHidden({ clientHeight: 500, isConnected: true })).toBe(false);
  });

  it('never pages older history while hidden or restoring', () => {
    expect(mayFetchOlder({ hidden: true, restoring: false })).toBe(false);
    expect(mayFetchOlder({ hidden: false, restoring: true })).toBe(false);
    expect(mayFetchOlder({ hidden: false, restoring: false })).toBe(true);
  });
});
