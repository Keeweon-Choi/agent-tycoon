import { useCallback, useEffect, useRef } from 'react';

import { atBottom } from './scrollJump.js';
import { isHidden, restoreTop } from './scrollRestore.js';

/**
 * A scroller that opens at its newest end, follows new content while the reader
 * is there, and holds the reader's row once they scroll up. Rows are the
 * `[data-keep]` elements inside it. A window that loses layout (minimized) comes
 * back where it was, the same rules as a DM conversation.
 */
export function useKeepPlace() {
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const place = useRef({
    stuck: true,
    anchor: null as { id: string; top: number } | null,
    savedTop: 0,
  });
  const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-keep]')];
  /** A row's offset inside the scrolled content, whatever the scroll is now. */
  const offset = (el: HTMLElement, row: HTMLElement) =>
    row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;

  const onScroll = useCallback(() => {
    const el = list.current;
    if (!el || isHidden(el)) return;
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
    if (!el || !inner) return;
    const apply = () => {
      if (isHidden(el)) return;
      const p = place.current;
      const row = p.anchor && rows(el).find((r) => r.dataset.keep === p.anchor!.id);
      el.scrollTop = restoreTop(
        {
          stuck: p.stuck,
          anchorTop: p.anchor?.top ?? null,
          rowOffsetTop: row ? offset(el, row) : null,
          savedTop: p.savedTop,
        },
        el,
      );
      p.savedTop = el.scrollTop;
    };
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    observer.observe(inner);
    apply();
    return () => observer.disconnect();
  }, []);

  return { list, content, onScroll };
}
