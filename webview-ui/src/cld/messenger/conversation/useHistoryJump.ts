import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatItem, ChatSearchHit } from '../../../../../core/src/messages.js';
import { JUMP_WAIT_MS } from '../../../constants.js';
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
import { isHidden, mayFetchOlder } from '../scrollRestore.js';

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
}: {
  agentId: number;
  m: MessengerSnapshot;
  items: ChatItem[] | undefined;
  list: RefObject<HTMLDivElement | null>;
  restoring: RefObject<boolean>;
  stuck: RefObject<boolean>;
  setAway: Dispatch<SetStateAction<boolean>>;
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
    el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
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
      { root: el },
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
    setAway(true);
    row.scrollIntoView({ block: 'center' });
    row.dataset.focused = 'true';
    window.setTimeout(() => {
      delete row.dataset.focused;
    }, FOCUS_MS);
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
    (hit: ChatSearchHit) => {
      setJumpLoading(agentId, true);
      stuck.current = false;
      setTargetItem({ id: hit.id, at: hit.at });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Conversation's stable refs/setter, see above
    [agentId],
  );
  return { sentinel, historyBusy, historyDone, full, fetchOlder, openQuote, jumpToHit };
}
