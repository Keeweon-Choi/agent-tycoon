import { describe, expect, it } from 'vitest';

import { standaloneBottomShortfall } from './standaloneViewport.js';

describe('standaloneBottomShortfall', () => {
  it('extends by the gap when the viewport is short by the top inset (iPhone 12/13 PWA)', () => {
    expect(standaloneBottomShortfall(844, 797, 47)).toBe(47);
  });
  it('does nothing on a full viewport, a phone without an inset, or other gaps', () => {
    expect(standaloneBottomShortfall(844, 844, 47)).toBe(0);
    expect(standaloneBottomShortfall(780, 740, 0)).toBe(0);
    expect(standaloneBottomShortfall(844, 700, 47)).toBe(0); // browser toolbars
    expect(standaloneBottomShortfall(390, 844, 47)).toBe(0); // rotated/odd screen
  });
});
