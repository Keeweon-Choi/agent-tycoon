import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { ChatItem } from '../../../../../core/src/messages.js';
import { transport } from '../../../transport/index.js';
import type { MessengerSnapshot, PendingSend } from '../messengerStore.js';
import { atBottom, newSince } from '../scrollJump.js';
import { holdTop, isHidden, restoreTop } from '../scrollRestore.js';

interface Place {
  stuck: boolean;
  anchor: { id: string; top: number } | null;
  savedTop: number;
  seen: string | undefined;
}
/** T-170: an open conversation's place while its view is away (another tab, another split layout:
 *  each remounts it). Forgotten when its chatView is let go (closed), which opens at the newest again. */
const places = new Map<number, Place>();
export const forgetPlace = (agentId: number) => void places.delete(agentId);

/**
 * Conversation's scroll pinning: follow the newest while at the bottom, keep the reader's
 * row fixed away from it, restore the position when a hidden list shows again, the
 * missed count, onScroll and the jump to the bottom. `list`, `readerAnchor`, `restoring`,
 * `savedTop`, `stuck` and `setAway` are Conversation's own, shared with its history paging
 * and submit. They are its useRef/useState values, stable across renders, so the dependency
 * arrays stay as they were in Conversation (exhaustive-deps cannot see that through parameters).
 */
export function useStickToBottom({
  agentId,
  m,
  items,
  pending,
  typing,
  list,
  readerAnchor,
  restoring,
  savedTop,
  stuck,
  setAway,
}: {
  agentId: number;
  m: MessengerSnapshot;
  items: ChatItem[] | undefined;
  pending: PendingSend[];
  typing: boolean;
  list: RefObject<HTMLDivElement | null>;
  readerAnchor: RefObject<{ id: string; top: number } | null>;
  restoring: RefObject<boolean>;
  savedTop: RefObject<number>;
  stuck: RefObject<boolean>;
  setAway: Dispatch<SetStateAction<boolean>>;
}) {
  const jumping = useRef(false); // a smooth scroll to the bottom is under way
  const seen = useRef<string | undefined>(undefined); // newest message the reader had in view
  const [missed, setMissed] = useState(0);
  // Before the pinning below: a view that comes back takes the place it left, as a shown-again list does.
  useLayoutEffect(() => {
    const was = places.get(agentId);
    const el = list.current;
    if (was) {
      stuck.current = was.stuck;
      readerAnchor.current = was.anchor;
      savedTop.current = was.savedTop;
      seen.current = was.seen;
      setAway(!was.stuck);
      if (el && !isHidden(el)) {
        const row = was.anchor && el.querySelector<HTMLElement>(`[data-chat-id="${was.anchor.id}"]`);
        el.scrollTop = restoreTop(
          {
            stuck: was.stuck,
            anchorTop: was.anchor?.top ?? null,
            rowOffsetTop: row?.offsetTop ?? null,
            savedTop: was.savedTop,
          },
          el,
        );
      }
    }
    return () =>
      void places.set(agentId, {
        stuck: stuck.current,
        anchor: readerAnchor.current,
        savedTop: savedTop.current,
        seen: seen.current,
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, [agentId]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || isHidden(el)) return;
    if (stuck.current) {
      el.scrollTop = el.scrollHeight;
      savedTop.current = el.scrollTop;
      seen.current = items?.at(-1)?.id;
      readerAnchor.current = null;
      return;
    }
    const anchor = readerAnchor.current;
    const row = anchor && el.querySelector<HTMLElement>(`[data-chat-id="${anchor.id}"]`);
    if (row) {
      holdTop(el, row.offsetTop - anchor.top);
      savedTop.current = el.scrollTop;
    }
    setMissed(newSince(items ?? [], seen.current));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, [items, pending.length, typing]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    let hidden = isHidden(el);
    if (hidden) restoring.current = true;
    else savedTop.current = el.scrollTop;
    const observer = new ResizeObserver(() => {
      const nextHidden = isHidden(el);
      if (nextHidden) {
        if (!hidden) restoring.current = true;
      } else if (hidden) {
        const anchor = readerAnchor.current;
        const row = anchor && el.querySelector<HTMLElement>(`[data-chat-id="${anchor.id}"]`);
        el.scrollTop = restoreTop(
          {
            stuck: stuck.current,
            anchorTop: anchor?.top ?? null,
            rowOffsetTop: row?.offsetTop ?? null,
            savedTop: savedTop.current,
          },
          el,
        );
        savedTop.current = el.scrollTop;
        restoring.current = false;
      } else {
        // A list that opens before its window is sized has no overflow to pin;
        // when it gets its height, a reader at the bottom is still at the bottom.
        if (stuck.current)
          el.scrollTop = restoreTop(
            { stuck: true, anchorTop: null, rowOffsetTop: null, savedTop: 0 },
            el,
          );
        savedTop.current = el.scrollTop;
      }
      hidden = nextHidden;
    });
    observer.observe(el);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, []);
  const onScroll = () => {
    const el = list.current;
    if (!el || isHidden(el)) return;
    savedTop.current = el.scrollTop;
    if (jumping.current) {
      if (atBottom(el)) jumping.current = false;
      return;
    }
    const bottom = atBottom(el);
    stuck.current = bottom;
    setAway(!bottom);
    if (bottom) {
      seen.current = items?.at(-1)?.id;
      setMissed(0);
      readerAnchor.current = null;
      return;
    }
    seen.current ??= items?.at(-1)?.id;
    const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find(
      (node) => node.offsetTop + node.offsetHeight > el.scrollTop,
    );
    readerAnchor.current = row
      ? { id: row.dataset.chatId!, top: row.offsetTop - el.scrollTop }
      : null;
  };
  const jump = () => {
    const el = list.current;
    if (!el) return;
    stuck.current = true;
    jumping.current = true;
    seen.current = items?.at(-1)?.id;
    setAway(false);
    setMissed(0);
    readerAnchor.current = null;
    if (m.historyWindowed[agentId]) {
      // A jump dropped the newest items: ask for the tail again (chatView answers in full).
      transport.send({ type: 'chatView', agentId, on: true });
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  // Replies an older window did not take in are new too (the jump reloads the tail with them).
  const windowedNew = m.windowedNew[agentId]?.length ?? 0;
  return { jumping, missed: missed + windowedNew, setMissed, onScroll, jump };
}
