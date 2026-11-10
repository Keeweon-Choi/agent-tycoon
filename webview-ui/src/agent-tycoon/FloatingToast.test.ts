import { describe, expect, it } from 'vitest';

import { swipeDismiss } from './toastSwipe.js';

describe('swipeDismiss', () => {
  it('dismisses a long upward drag or a quick upward flick', () => {
    expect(swipeDismiss(-40, 500)).toBe(true);
    expect(swipeDismiss(-12, 180)).toBe(true);
  });

  it('keeps short, slow, or downward drags visible', () => {
    expect(swipeDismiss(-39, 500)).toBe(false);
    expect(swipeDismiss(-11, 100)).toBe(false);
    expect(swipeDismiss(40, 100)).toBe(false);
  });
});
