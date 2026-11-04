import type { RefObject } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { tagText } from '../../../../../core/src/cld/questionTag.js';
import type { ChatSearchHit } from '../../../../../core/src/messages.js';
import { t } from '../../../i18n/index.js';
import { transport } from '../../../transport/index.js';
import { cldOwnToast } from '../../officeStore.js';
import { type MessengerSnapshot, requestSearch } from '../messengerStore.js';
import { nextRequestId } from '../parts.js';
import { flashRow } from './useHistoryJump.js';

/**
 * MSGQ: a question tag's chip was tapped. The tag's text is searched with the chat search (so earlier
 * sessions count), the oldest hit is the message the tag first appeared in, and the chat search's
 * own jump goes there (older pages load by themselves). The chip of that message itself only flashes it.
 */
export function useQuestionTag({
  agentId,
  m,
  list,
  jumpToHit,
  clearSearch,
}: {
  agentId: number;
  m: MessengerSnapshot;
  list: RefObject<HTMLDivElement | null>;
  jumpToHit: (hit: ChatSearchHit) => void;
  clearSearch: () => void;
}) {
  const [seek, setSeek] = useState<{ requestId: string; fromId: string } | null>(null);
  const openTag = useCallback(
    (name: string, fromId: string) => {
      clearSearch(); // the search bar shares the store's results for this chat
      const requestId = nextRequestId();
      setSeek({ requestId, fromId });
      requestSearch(agentId, requestId);
      transport.send({ type: 'chatSearch', agentId, requestId, query: tagText(name) });
    },
    [agentId, clearSearch],
  );
  const result = m.searchResults[agentId];
  const busy = m.searchBusy[agentId];
  useEffect(() => {
    if (!seek || result?.requestId !== seek.requestId || busy) return;
    setSeek(null);
    // Newest first, at most 50: the last is the oldest.
    // ponytail: a tag said over 50 times lands on the oldest of the newest 50.
    const first = result.hits.at(-1);
    if (!first) {
      cldOwnToast(t('messenger.title'), t('msgq.notFound'), 'info');
      return;
    }
    if (first.id !== seek.fromId) {
      jumpToHit(first);
      return;
    }
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? [])].find(
      (node) => node.dataset.chatId === seek.fromId,
    );
    if (row) flashRow(row);
  }, [seek, result, busy, jumpToHit, list]);
  return { openTag };
}
