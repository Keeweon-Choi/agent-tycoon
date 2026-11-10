import { describe, expect, it } from 'vitest';

import { isTextTarget, openContextMenu, registerContextTarget } from './inputPolicy.js';

/** An element that matches a selector list when one of its words is in `has`. */
const el = (...has: string[]) => ({
  closest: (sel: string) => (has.some((h) => sel.includes(h)) ? {} : null),
});

describe('isTextTarget', () => {
  it('inputs, textareas, contenteditable and the terminal are text areas', () => {
    for (const w of ['textarea', 'contenteditable', '.xterm'])
      expect(isTextTarget(el(w), false)).toBe(true);
  });
  it('data-selectable counts on a mouse, not on a touch screen', () => {
    expect(isTextTarget(el('[data-selectable]'), false)).toBe(true);
    expect(isTextTarget(el('[data-selectable]'), true)).toBe(false);
  });
  it('data-selectable="always" (file text, job logs) counts on a touch screen too', () => {
    expect(isTextTarget(el('always'), true)).toBe(true);
  });
  it('a plain element, a text node and null are game areas', () => {
    expect(isTextTarget(el(), false)).toBe(false);
    expect(isTextTarget({}, false)).toBe(false);
    expect(isTextTarget(null, false)).toBe(false);
  });
});

describe('context menu registry', () => {
  const ev = { target: null, x: 1, y: 2, keyboard: false };
  it('the first opener that takes the event wins; unregistering removes it', () => {
    const off = registerContextTarget('t-a', () => false);
    const offB = registerContextTarget('t-b', (e) => e.x === 1);
    expect(openContextMenu(ev)).toBe('t-b');
    offB();
    expect(openContextMenu(ev)).toBeNull();
    off();
  });
});
