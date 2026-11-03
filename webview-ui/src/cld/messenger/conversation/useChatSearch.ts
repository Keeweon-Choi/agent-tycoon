import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ChatSearchHit } from '../../../../../core/src/messages.js';
import { transport } from '../../../transport/index.js';
import { type MessengerSnapshot, requestSearch } from '../messengerStore.js';
import { nextRequestId } from '../parts.js';
import { stepSearchResult } from '../searchMatch.js';

/** Conversation's search: the query, its debounce, Escape, the first-hit jump and stepping. */
export function useChatSearch({
  agentId,
  m,
  jumpToHit,
}: {
  agentId: number;
  m: MessengerSnapshot;
  jumpToHit: (hit: ChatSearchHit) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [searchRequest, setSearchRequest] = useState('');
  const [activeResult, setActiveResult] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const searchResult = m.searchResults[agentId];
  const hits = useMemo(() => searchResult?.hits ?? [], [searchResult]);
  const clearSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setSearched('');
    setSearchRequest('');
    setActiveResult(-1);
    setListOpen(false);
  }, []);
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      clearSearch();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [searchOpen, clearSearch]);
  const search = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const requestId = nextRequestId();
    setSearched(trimmed);
    setSearchRequest(requestId);
    setActiveResult(-1);
    requestSearch(agentId, requestId);
    transport.send({ type: 'chatSearch', agentId, requestId, query });
  }, [agentId, query]);
  useEffect(() => {
    if (!searchOpen || query.trim().length < 2 || query.trim() === searched) return;
    const timer = window.setTimeout(search, 180);
    return () => window.clearTimeout(timer);
  }, [searchOpen, query, searched, search]);
  useEffect(() => {
    if (searchResult?.requestId !== searchRequest || m.searchBusy[agentId] || !hits.length) return;
    setActiveResult(0);
    jumpToHit(hits[0]);
  }, [searchResult, searchRequest, m.searchBusy, agentId, hits, jumpToHit]);
  const stepResult = (direction: 'older' | 'newer') => {
    const next = stepSearchResult(activeResult, hits.length, direction);
    if (next < 0) return;
    setActiveResult(next);
    jumpToHit(hits[next]);
  };
  return {
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    searched,
    setSearched,
    activeResult,
    setActiveResult,
    listOpen,
    setListOpen,
    hits,
    clearSearch,
    search,
    stepResult,
  };
}
