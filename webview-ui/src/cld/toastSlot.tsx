import { type RefObject, useLayoutEffect, useRef } from 'react';

/** UI-FIX 2: every pop-up notice (FloatingToast) renders into this one fixed element under the clock bar. */
const SLOT_ID = 'cld-toast-slot';
/**
 * DESKTOP-ACTIONS (owner 11-03): the answer to the user's own click (복사, 내려받기, ...) goes over every
 * window and the attachment viewer, else it showed under the very window it came from. Passive
 * notices keep the slot under the windows (UI-FIX 2).
 * ponytail: both slots start at the same top, so an answer covers a passive notice for its 2-8 s.
 */
const OVER_SLOT_ID = 'cld-toast-slot-over';

export function toastSlot(over = false): HTMLElement {
  const id = over ? OVER_SLOT_ID : SLOT_ID;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = over ? 'cld-toast-slot cld-toast-slot-over' : 'cld-toast-slot';
    document.body.appendChild(el);
  }
  return el;
}

/**
 * The clock bar's ref: its bottom edge becomes `--cld-toast-top`, where the slot starts.
 * ponytail: measured on mount and resize only, so a dragged desktop bar keeps the old edge.
 */
export function useToastTop<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--cld-toast-top', `${el.getBoundingClientRect().bottom}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--cld-toast-top');
    };
  }, []);
  return ref;
}
