import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';

import type { ChatSearchHit } from '../../../../../core/src/messages.js';
import { isNearMark, markOf, type ReturnMark } from '../returnMark.js';
import { atBottom } from '../scrollJump.js';

const rowsOf = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].map((node) => ({
    id: node.dataset.chatId!,
    offsetTop: node.offsetTop,
    offsetHeight: node.offsetHeight,
  }));
const rowFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((node) => node.dataset.chatId === id);

/**
 * Conversation's way back from a jump (a question tag's ↗ 원문, a quote, a search hit, a library
 * file): the place the reader left is remembered when the jump lands, and a floating button returns
 * there. Several jumps in a row (no wheel or touch between) keep the first place. The mark goes
 * when the button is used or the reader scrolls back to it by hand.
 */
export function useReturnMark(list: RefObject<HTMLDivElement | null>) {
  const [mark, setMark] = useState<ReturnMark | null>(null);
  const held = useRef<ReturnMark | null>(null);
  const chained = useRef(false); // the list has not been moved by hand since the last jump
  const skip = useRef(false); // the next landing is the way back itself
  const set = useCallback((next: ReturnMark | null) => {
    held.current = next;
    setMark(next);
  }, []);
  /** Called as a jump lands, before the list scrolls. */
  const remember = useCallback(() => {
    const el = list.current;
    if (!el) return;
    if (skip.current) {
      skip.current = false;
      return;
    }
    if (chained.current && held.current) return;
    chained.current = true;
    set(markOf(rowsOf(el), el.scrollTop, atBottom(el)));
  }, [list, set]);
  /** The reader moved the list (wheel, touch): the next jump leaves from a new place. */
  const moved = useCallback(() => {
    chained.current = false;
  }, []);
  /** On scroll: back near the mark means the button has done its work. */
  const watch = useCallback(() => {
    const el = list.current;
    const at = held.current;
    if (!el || !at) return;
    const row = at.id === null ? null : rowFor(el, at.id);
    if (at.id === null ? atBottom(el) : row && isNearMark(row.offsetTop - at.top - el.scrollTop, el.clientHeight))
      set(null);
  }, [list, set]);
  const goBack = useCallback(
    (to: { bottom: () => void; hit: (hit: Pick<ChatSearchHit, 'id' | 'at'>) => void }) => {
      const at = held.current;
      set(null);
      chained.current = false;
      const el = list.current;
      if (!at || !el) return;
      if (at.id === null) return to.bottom();
      const row = rowFor(el, at.id);
      if (row) el.scrollTop = row.offsetTop - at.top;
      else {
        skip.current = true; // its page was dropped: ask for it, and do not mark that landing
        to.hit({ id: at.id, at: at.at });
      }
    },
    [list, set],
  );
  return { mark, remember, moved, watch, goBack };
}
