import { describe, expect, it } from 'vitest';

import { COMPOSER_MAX_LINES, composerHeight } from './composerGrow.js';

const base = { lineHeight: 20, extra: 14, viewportHeight: 900, phone: false };
const content = (lines: number) => lines * 20 + 14;

describe('composerHeight', () => {
  it('starts at one line, empty or not', () => {
    expect(composerHeight({ ...base, content: content(1) })).toEqual({
      height: 34,
      scrolls: false,
    });
    expect(composerHeight({ ...base, content: 0 })).toEqual({ height: 34, scrolls: false });
  });

  it('keeps any inactive draft to one line without scrolling', () => {
    for (const draftHeight of [0, content(1), content(40)]) {
      expect(composerHeight({ ...base, content: draftHeight, collapsed: true })).toEqual({
        height: 34,
        scrolls: false,
      });
    }
  });

  it('grows a line at a time', () => {
    expect(composerHeight({ ...base, content: content(2) }).height).toBe(54);
    expect(composerHeight({ ...base, content: content(5) }).height).toBe(114);
  });

  it('stops at 8 lines on a desktop and scrolls inside', () => {
    expect(composerHeight({ ...base, content: content(COMPOSER_MAX_LINES) })).toEqual({
      height: 174,
      scrolls: false,
    });
    expect(composerHeight({ ...base, content: content(9) })).toEqual({
      height: 174,
      scrolls: true,
    });
    expect(composerHeight({ ...base, content: content(40) })).toEqual({
      height: 174,
      scrolls: true,
    });
  });

  it('stops at a third of the screen on a phone', () => {
    const phone = { ...base, phone: true, viewportHeight: 852 };
    expect(composerHeight({ ...phone, content: content(3) })).toEqual({
      height: 74,
      scrolls: false,
    });
    expect(composerHeight({ ...phone, content: content(30) })).toEqual({
      height: 284,
      scrolls: true,
    });
  });

  it('never goes below one line, even on a very short screen', () => {
    expect(
      composerHeight({ ...base, phone: true, viewportHeight: 60, content: content(4) }),
    ).toEqual({
      height: 34,
      scrolls: true,
    });
  });

  it('shrinks back when the content does', () => {
    const grown = composerHeight({ ...base, content: content(6) }).height;
    const sent = composerHeight({ ...base, content: content(1) }).height;
    expect(sent).toBeLessThan(grown);
    expect(sent).toBe(34);
  });
});
