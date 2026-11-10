import { describe, expect, it } from 'vitest';

import { holdTop, isHidden, mayFetchOlder, prependedTop, restoreTop } from './scrollRestore.js';

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

describe('older messages landing above the reader', () => {
  it('moves the list down by the height the new rows added', () => {
    // 30 px from the top of a 3000 px list; 1200 px of older rows arrive above.
    expect(prependedTop({ height: 3000, top: 30 }, 4200)).toBe(1230);
    expect(prependedTop({ height: 3000, top: 0 }, 3000)).toBe(0);
  });

  const fakeList = (scrollTop: number) => {
    const steps: string[] = [];
    let top = scrollTop;
    let overflowY = '';
    const el = {
      style: {
        get overflowY() {
          return overflowY;
        },
        set overflowY(v: string) {
          overflowY = v;
          steps.push(`overflow:${v || 'auto'}`);
        },
      },
      get scrollTop() {
        return top;
      },
      set scrollTop(v: number) {
        steps.push(`top:${overflowY}`);
        top = v;
      },
      offsetHeight: 500,
    };
    return { el: el as unknown as HTMLElement, steps };
  };

  it('sets the position with the overflow hidden, then gives the overflow back', () => {
    const { el, steps } = fakeList(0);
    holdTop(el, 1230);
    expect(el.scrollTop).toBe(1230);
    expect(steps).toEqual(['overflow:hidden', 'top:hidden', 'overflow:auto']);
  });

  it('leaves a list that is already there alone (a phone keeps its momentum)', () => {
    const { el, steps } = fakeList(1230);
    holdTop(el, 1230.5);
    expect(steps).toEqual([]);
  });
});
