import { expect, it } from 'vitest';

import { CHORD_MS, chordStep, enterSends, enterSendsNow } from './sendKey.js';

const enter = { key: 'Enter', shiftKey: false, isComposing: false };

it('desktop: Enter sends, Shift+Enter is a newline', () => {
  expect(enterSends(enter, false)).toBe(true);
  expect(enterSends({ ...enter, shiftKey: true }, false)).toBe(false);
});

it('touch: Enter is always a newline, only the button sends', () => {
  expect(enterSends(enter, true)).toBe(false);
  expect(enterSends({ ...enter, shiftKey: true }, true)).toBe(false);
});

it('never sends mid-composition (Hangul IME), on either device', () => {
  expect(enterSends({ ...enter, isComposing: true }, false)).toBe(false);
  expect(enterSends({ ...enter, keyCode: 229 }, false)).toBe(false);
  expect(enterSends({ ...enter, isComposing: true }, true)).toBe(false);
});

it('other keys never send', () => {
  expect(enterSends({ ...enter, key: 'a' }, false)).toBe(false);
});

it('Ctrl+Enter or Cmd+Enter sends now, on either device; plain Enter and the IME do not', () => {
  expect(enterSendsNow({ ...enter, ctrlKey: true })).toBe(true);
  expect(enterSendsNow({ ...enter, metaKey: true })).toBe(true);
  expect(enterSendsNow(enter)).toBe(false);
  expect(enterSendsNow({ ...enter, ctrlKey: true, isComposing: true })).toBe(false);
  expect(enterSendsNow({ ...enter, ctrlKey: true, keyCode: 229 })).toBe(false);
});

it('Ctrl+X then Ctrl+S within 1.5 s sends now; a selection still cuts; other keys or a late S do not', () => {
  const x = { key: 'x', ctrlKey: true, selected: false };
  const sKey = { key: 's', ctrlKey: true, selected: false };
  const armed = chordStep(null, x, 1_000);
  expect(armed).toEqual({ armedAt: 1_000, send: false, consume: true });
  expect(
    chordStep(armed.armedAt, { key: 'Control', ctrlKey: true, selected: false }, 1_100),
  ).toMatchObject({ armedAt: 1_000, send: false });
  expect(chordStep(armed.armedAt, sKey, 1_000 + CHORD_MS)).toEqual({
    armedAt: null,
    send: true,
    consume: true,
  });
  expect(chordStep(armed.armedAt, sKey, 1_001 + CHORD_MS)).toMatchObject({ send: false });
  expect(chordStep(armed.armedAt, { key: 'a', ctrlKey: false, selected: false }, 1_100)).toEqual({
    armedAt: null,
    send: false,
    consume: false,
  });
  expect(chordStep(null, { ...x, selected: true }, 1_000)).toMatchObject({ consume: false });
  expect(chordStep(null, sKey, 1_000)).toMatchObject({ send: false, consume: false });
});
