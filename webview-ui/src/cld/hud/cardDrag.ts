/**
 * The member card's drag by its head (owner 11-06 20:22: "움직일 수 있게"), the HudWindow way: the pointer
 * only records its latest position, once per frame the card is shifted with a transform, and it stays
 * wholly on screen. Nothing is remembered: a new selection opens beside its portrait again (the offset
 * lives in the card's own state).
 */
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useState } from 'react';

import { clampRect, type Rect, type Size } from './layout.js';

export interface Offset {
  x: number;
  y: number;
}

/** The translation asked (`want`) for a card whose untranslated box is `home`, pulled so it stays inside `view`. */
export function keepOnScreen(home: Rect, want: Offset, view: Size): Offset {
  const r = clampRect({ x: home.x + want.x, y: home.y + want.y, w: home.w, h: home.h }, view);
  return { x: r.x - home.x, y: r.y - home.y };
}

const viewSize = (): Size => ({ w: window.innerWidth, h: window.innerHeight });

/** The card's untranslated box: where it is now, less the offset applied. */
function homeOf(el: HTMLElement, off: Offset): Rect {
  const b = el.getBoundingClientRect();
  return { x: b.left - off.x, y: b.top - off.y, w: b.width, h: b.height };
}

/** The offset (null: never dragged) and the head's pointerdown that drags it. */
export function useCardDrag(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const [off, setOff] = useState<Offset | null>(null);
  // A dragged card stays on screen when the window or the card itself changes size.
  useEffect(() => {
    const el = ref.current;
    if (!off || !el) return;
    const keep = () => {
      const next = keepOnScreen(homeOf(el, off), off, viewSize());
      if (next.x !== off.x || next.y !== off.y) setOff(next);
    };
    const sizes = new ResizeObserver(keep);
    sizes.observe(el);
    window.addEventListener('resize', keep);
    return () => {
      sizes.disconnect();
      window.removeEventListener('resize', keep);
    };
  }, [off, ref]);

  const begin = (e: ReactPointerEvent) => {
    const el = ref.current;
    if (!enabled || !el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest('button,input,select,a')) return;
    e.preventDefault();
    const from = off ?? { x: 0, y: 0 };
    const home = homeOf(el, from);
    const start = { x: e.clientX, y: e.clientY };
    let last = from;
    let frame = 0;
    let ask = from;
    const paint = () => {
      frame = 0;
      last = keepOnScreen(home, ask, viewSize());
      el.style.transform = `translate(${last.x}px, ${last.y}px)`;
    };
    const onMove = (ev: PointerEvent) => {
      ask = { x: from.x + ev.clientX - start.x, y: from.y + ev.clientY - start.y };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (frame) cancelAnimationFrame(frame);
      paint();
      if (last.x !== from.x || last.y !== from.y) setOff(last);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  return { off, begin };
}
