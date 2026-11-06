import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatItem, ChatSearchHit } from '../../../../../core/src/messages.js';
import { HISTORY_PREFETCH_PX, JUMP_WAIT_MS } from '../../../constants.js';
import { t } from '../../../i18n/index.js';
import { transport } from '../../../transport/index.js';
import { FOCUS_MS } from '../../notify/openTarget.js';
import { cldOwnToast } from '../../officeStore.js';
import { findReplied } from '../messageActions.js';
import {
  clearPendingJump,
  jumpStep,
  jumpTarget,
  MAX_ITEMS,
  type MessengerSnapshot,
  requestHistory,
  setJumpLoading,
} from '../messengerStore.js';
import { nextRequestId } from '../parts.js';
import { holdTop, isHidden, mayFetchOlder, prependedTop } from '../scrollRestore.js';

/** Outline a message row for a moment (a jump landed on it, or a tag chip points at its own line). */
export function flashRow(row: HTMLElement): void {
  row.dataset.focused = 'true';
  window.setTimeout(() => {
    delete row.dataset.focused;
  }, FOCUS_MS);
}

/**
 * Conversation's history paging and jumps: older pages (prepend restore, the top
 * sentinel), a pending jump from a link, a search hit or a tapped quote. `list`,
 * `restoring`, `stuck` and `setAway` are Conversation's own, shared with its scroll pinning.
 * They are its useRef/useState values, stable across renders, so the dependency arrays stay
 * as they were in Conversation (exhaustive-deps cannot see that through parameters).
 */
export function useHistoryJump({
  agentId,
  m,
  items,
  list,
  restoring,
  stuck,
  setAway,
  remember,
}: {
  agentId: number;
  m: MessengerSnapshot;
  items: ChatItem[] | undefined;
  list: RefObject<HTMLDivElement | null>;
  restoring: RefObject<boolean>;
  stuck: RefObject<boolean>;
  setAway: Dispatch<SetStateAction<boolean>>;
  /** A jump is about to scroll: where the reader is now is where the way back goes. */
  remember: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const [targetItem, setTargetItem] = useState<{ at: number; id?: string } | null>(null);
  // The jump's bounded wait for a message that has not arrived yet ran out (for this target).
  const [waitedOut, setWaitedOut] = useState<typeof targetItem>(null);
  // A quote tapped: the original's id, sought through older pages until found.
  const [replySeek, setReplySeek] = useState<string | null>(null);
  const historyBusy = !!m.historyBusy[agentId];
  const historyDone = !!m.historyDone[agentId];
  const full = (items?.length ?? 0) >= MAX_ITEMS;
  const jumpLoading = !!m.jumpLoading[agentId];
  const historyError = m.historyError[agentId];
  const fetchOlder = useCallback(
    (until?: number) => {
      if (!items || historyBusy || historyDone || (full && !jumpLoading)) return;
      const el = list.current;
      if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      stuck.current = false;
      const requestId = nextRequestId();
      requestHistory(agentId, requestId);
      transport.send({
        type: 'chatHistory',
        agentId,
        requestId,
        ...(items[0] && { before: items[0].id }),
        ...(until !== undefined && { until }),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
    [items, historyBusy, historyDone, full, jumpLoading, agentId],
  );
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !prepend.current || historyBusy) return;
    holdTop(el, prependedTop(prepend.current, el.scrollHeight));
    prepend.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, [items, historyBusy]);
  useEffect(() => {
    const el = list.current;
    const top = sentinel.current;
    if (!el || !top || !items || targetItem || historyDone || historyBusy || full || historyError)
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry.isIntersecting &&
          mayFetchOlder({ hidden: isHidden(el), restoring: restoring.current })
        ) {
          fetchOlder();
        }
      },
      { root: el, rootMargin: `${HISTORY_PREFETCH_PX}px 0px 0px 0px` },
    );
    observer.observe(top);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, [items, targetItem, historyDone, historyBusy, full, historyError, fetchOlder]);
  useEffect(() => {
    if (m.pendingJump?.agentId !== agentId) return;
    setJumpLoading(agentId, true);
    stuck.current = false;
    setTargetItem({ at: m.pendingJump.at, id: m.pendingJump.id });
    clearPendingJump(agentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, [m.pendingJump, agentId]);
  useEffect(() => {
    if (!targetItem || !items) return;
    const plan = jumpStep(items, targetItem, {
      live: !!m.tailLive[agentId],
      historyDone,
      waitedOut: waitedOut === targetItem,
    });
    if (plan.step === 'wait') return; // the next transcript (or the timer below) wakes this
    if (plan.step === 'older') {
      if (!historyError && (!full || jumpLoading)) {
        fetchOlder(targetItem.at);
        return;
      }
    }
    // 'older' that cannot be fetched (error, a full window) ends by time, as before.
    const found = plan.step === 'found' ? plan.item : jumpTarget(items, targetItem.at, targetItem.id);
    if (historyBusy) return;
    if (!found) {
      setTargetItem(null); // nothing that old: stay where the reader is
      setJumpLoading(agentId, false);
      return;
    }
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? [])].find(
      (node) => node.dataset.chatId === found.id,
    );
    if (!row) return;
    stuck.current = false;
    remember();
    setAway(true);
    // The marked word of a search hit, not the middle of a tall bubble (its fold may still open: Line).
    (row.querySelector('mark.bg-search-current') ?? row).scrollIntoView({ block: 'center' });
    flashRow(row);
    setTargetItem(null);
    setJumpLoading(agentId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
  }, [
    targetItem,
    items,
    historyBusy,
    historyDone,
    full,
    historyError,
    jumpLoading,
    fetchOlder,
    agentId,
    m.tailLive,
    waitedOut,
    remember,
  ]);
  useEffect(() => {
    if (!targetItem) return;
    const timer = window.setTimeout(() => setWaitedOut(targetItem), JUMP_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [targetItem]);
  useEffect(() => {
    if (!replySeek || !items) return;
    const found = findReplied(items, replySeek);
    if (found) {
      setReplySeek(null);
      setTargetItem({ at: found.at, id: found.id }); // scrolls there and highlights it
      return;
    }
    if (historyBusy) return;
    if (historyDone || historyError) {
      setReplySeek(null);
      setJumpLoading(agentId, false);
      cldOwnToast(t('messenger.title'), t('messenger.replyNotFound'), 'info');
      return;
    }
    fetchOlder();
  }, [replySeek, items, historyBusy, historyDone, historyError, fetchOlder, agentId]);
  const openQuote = useCallback(
    (id: string) => {
      setJumpLoading(agentId, true); // older pages past MAX_ITEMS too, as a search jump
      stuck.current = false;
      setReplySeek(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
    [agentId],
  );
  const jumpToHit = useCallback(
    (hit: Pick<ChatSearchHit, 'id' | 'at'>) => {
      setJumpLoading(agentId, true);
      stuck.current = false;
      setTargetItem({ id: hit.id, at: hit.at });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
    [agentId],
  );
  return { sentinel, historyBusy, historyDone, full, fetchOlder, openQuote, jumpToHit };
}
