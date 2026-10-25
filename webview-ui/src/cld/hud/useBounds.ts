import { type RefObject, useLayoutEffect, useState } from 'react';

import type { Rect, Size } from './layout.js';

/** The room a positioned thing lives in: its containing block (offsetParent), followed through resizes. */
export function useBounds(ref: RefObject<HTMLElement | null>): Size | null {
  const [bounds, setBounds] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const parent = ref.current?.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    const read = () =>
      setBounds((prev) =>
        prev && prev.w === parent.clientWidth && prev.h === parent.clientHeight
          ? prev
          : { w: parent.clientWidth, h: parent.clientHeight },
      );
    read();
    const observer = new ResizeObserver(read);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref]);
  return bounds;
}

/** The element's box inside its containing block (transforms included, unlike offsetLeft). */
export function rectInParent(el: HTMLElement): Rect | null {
  const parent = el.offsetParent;
  if (!(parent instanceof HTMLElement)) return null;
  const box = el.getBoundingClientRect();
  const room = parent.getBoundingClientRect();
  return {
    x: box.left - room.left - parent.clientLeft,
    y: box.top - room.top - parent.clientTop,
    w: box.width,
    h: box.height,
  };
}

/**
 * The boxes of the visible elements matching `selector` (but not `self`) inside `el`'s
 * containing block: the edges a dragged thing sticks to.
 */
export function siblingRects(self: HTMLElement, selector: string): Rect[] {
  const parent = self.offsetParent;
  if (!(parent instanceof HTMLElement)) return [];
  const room = parent.getBoundingClientRect();
  const out: Rect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el === self || el.offsetParent === null) continue; // hidden (closed, minimized)
    const box = el.getBoundingClientRect();
    out.push({
      x: box.left - room.left - parent.clientLeft,
      y: box.top - room.top - parent.clientTop,
      w: box.width,
      h: box.height,
    });
  }
  return out;
}
