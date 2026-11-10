import { describe, expect, it } from 'vitest';

import { keepOnScreen } from './cardDrag.js';

describe('the member card drag (owner 11-06 20:22)', () => {
  const view = { w: 1600, h: 1000 };
  const home = { x: 1200, y: 300, w: 300, h: 600 };
  it('moves where the pointer asks while the card stays inside', () => {
    expect(keepOnScreen(home, { x: -400, y: -100 }, view)).toEqual({ x: -400, y: -100 });
  });
  it('stops at every edge of the screen', () => {
    expect(keepOnScreen(home, { x: 500, y: 0 }, view)).toEqual({ x: 100, y: 0 }); // right edge
    expect(keepOnScreen(home, { x: -2000, y: 0 }, view)).toEqual({ x: -1200, y: 0 }); // left edge
    expect(keepOnScreen(home, { x: 0, y: 900 }, view)).toEqual({ x: 0, y: 100 }); // bottom edge
    expect(keepOnScreen(home, { x: 0, y: -900 }, view)).toEqual({ x: 0, y: -300 }); // top edge
  });
});
