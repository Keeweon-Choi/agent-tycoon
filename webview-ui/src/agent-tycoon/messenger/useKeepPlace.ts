import { useCallback, useEffect, useRef } from 'react';

import { SCROLL_HOLD_SLACK_PX } from '../../constants.js';
import { atBottom } from './scrollJump.js';
import { isHidden, restoreTop } from './scrollRestore.js';

interface Place {
  stuck: boolean;
  anchor: { id: string; top: number } | null;
  savedTop: number;
}
/** Each kept scroller's place while its view is away. */
const places = new Map<string, Place>();
/** Forget every place but `keys`' (the rooms whose tabs are still open). */
export const keepPlacesOf = (keys: readonly string[]) =>
  [...places.keys()].filter((key) => !keys.includes(key)).forEach((key) => places.delete(key));

/**
 * A scroller that opens at its newest end, follows new content while the reader
 * is there, and holds the reader's row once they scroll up. Rows are the
 * `[data-keep]` elements inside it. A window that loses layout (minimized) comes
 * back where it was, the same rules as a DM conversation. `key`'s place outlives a remount (another
 * tab, another split layout) while `kept()` says so when it goes (T-170).
 */
export function useKeepPlace(key: string, kept: () => boolean) {
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const place = useRef<Place>(places.get(key) ?? { stuck: true, anchor: null, savedTop: 0 });
  // A place taken back holds until its anchor row sits where it was (the rows below it load again after
  // a remount, and until then the list cannot scroll that far): scrolls on the way are not the reader's.
  // The reader's own wheel, press or key ends it.
  const restoring = useRef(!place.current.stuck && place.current.anchor !== null);
  const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-keep]')];
  /** A row's offset inside the scrolled content, whatever the scroll is now. */
  const offset = (el: HTMLElement, row: HTMLElement) =>
    row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;

  const onScroll = useCallback(() => {
    const el = list.current;
    if (!el || isHidden(el) || restoring.current) return;
    const p = place.current;
    p.savedTop = el.scrollTop;
    p.stuck = atBottom(el);
    const row = p.stuck
      ? undefined
      : rows(el).find((r) => offset(el, r) + r.offsetHeight > el.scrollTop);
    p.anchor = row ? { id: row.dataset.keep!, top: offset(el, row) - el.scrollTop } : null;
  }, []);

  useEffect(() => {
    const el = list.current;
    const inner = content.current;
    const saved = place.current; // one object for the mount's life
    if (!el || !inner) return;
    const apply = () => {
      if (isHidden(el)) return;
      const p = place.current;
      const row = p.anchor && rows(el).find((r) => r.dataset.keep === p.anchor!.id);
      if (restoring.current && !row && rows(el).length) {
        // Its row is gone (paged out, the room cleared): the newest end, not a wrong place.
        Object.assign(p, { stuck: true, anchor: null });
        restoring.current = false;
      }
      const top = restoreTop(
        {
          stuck: p.stuck,
          anchorTop: p.anchor?.top ?? null,
          rowOffsetTop: row ? offset(el, row) : null,
          savedTop: p.savedTop,
        },
        el,
      );
      el.scrollTop = top;
      if (Math.abs(el.scrollTop - top) <= SCROLL_HOLD_SLACK_PX) restoring.current = false;
      p.savedTop = el.scrollTop;
    };
    const take = () => {
      restoring.current = false;
    };
    const inputs = ['wheel', 'pointerdown', 'keydown'] as const;
    inputs.forEach((type) => el.addEventListener(type, take, { passive: true }));
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    observer.observe(inner);
    apply();
    return () => {
      observer.disconnect();
      inputs.forEach((type) => el.removeEventListener(type, take));
      if (kept()) places.set(key, saved);
      else places.delete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one list per mount (its owner keys it by room)
  }, []);

  return { list, content, onScroll };
}
