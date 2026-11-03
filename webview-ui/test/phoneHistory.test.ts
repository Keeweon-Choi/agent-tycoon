import { describe, expect, it } from 'vitest';

import { MOBILE_HISTORY_EDGE_PX } from '../src/constants.js';
import { blocksEdgeSwipe, GUARD, landing } from '../src/mobile/phoneHistory.js';

describe('landing', () => {
  it('tells our guard, a closed overlay entry and the page entry apart', () => {
    expect(landing({ [GUARD]: true })).toBe('guard');
    expect(landing({ cldAttach: true })).toBe('overlay');
    expect(landing({ cldBoard: true })).toBe('overlay');
    expect(landing(null)).toBe('page');
    expect(landing(undefined)).toBe('page');
  });
  it('negative control: a foreign or switched-off state is the page entry', () => {
    expect(landing({ [GUARD]: false })).toBe('page');
    expect(landing({ cldAttach: 1 })).toBe('page');
    expect(landing({ other: true })).toBe('page');
    expect(landing('cldTab')).toBe('page');
  });
});

describe('blocksEdgeSwipe', () => {
  const w = 393;
  it('cancels a touch starting in either edge strip', () => {
    expect(blocksEdgeSwipe(0, w, false)).toBe(true);
    expect(blocksEdgeSwipe(MOBILE_HISTORY_EDGE_PX - 1, w, false)).toBe(true);
    expect(blocksEdgeSwipe(w - 1, w, false)).toBe(true);
  });
  it('negative control: the middle, and a tap target at the edge, are left alone', () => {
    expect(blocksEdgeSwipe(MOBILE_HISTORY_EDGE_PX, w, false)).toBe(false);
    expect(blocksEdgeSwipe(w / 2, w, false)).toBe(false);
    expect(blocksEdgeSwipe(0, w, true)).toBe(false);
    expect(blocksEdgeSwipe(w - 1, w, true)).toBe(false);
  });
});
