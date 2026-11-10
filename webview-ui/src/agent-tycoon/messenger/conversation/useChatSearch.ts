import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  jumpToHit: (hit: Pick<ChatSearchHit, 'id' | 'at'>) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [searchRequest, setSearchRequest] = useState('');
  const [activeResult, setActiveResult] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  // The hit the list's overall search was opened at: the first jump goes to it, not to the newest match.
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  const searchResult = m.searchResults[agentId];
  const hits = useMemo(() => searchResult?.hits ?? [], [searchResult]);
  const clearSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setSearched('');
    setSearchRequest('');
    setActiveResult(-1);
    setListOpen(false);
    setFocus(null);
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
  // Opened from the list's overall search at a hit: this conversation's own search bar opens with the same
  // words (marked in the lines, stepping between matches) and the jump lands on that hit.
  const jump = m.pendingJump;
  useEffect(() => {
    if (jump?.agentId !== agentId || !jump.query || !jump.id) return;
    const requestId = nextRequestId();
    setSearchOpen(true);
    setQuery(jump.query);
    setSearched(jump.query);
    setSearchRequest(requestId);
    setActiveResult(-1);
    setFocus({ id: jump.id, at: jump.at });
    requestSearch(agentId, requestId);
    transport.send({ type: 'chatSearch', agentId, requestId, query: jump.query });
  }, [jump, agentId]);
  const jumpedFor = useRef('');
  useEffect(() => {
    if (searchResult?.requestId !== searchRequest || m.searchBusy[agentId]) return;
    if (focus) {
      const index = hits.findIndex((hit) => hit.id === focus.id);
      jumpedFor.current = searchRequest;
      setFocus(null);
      setActiveResult(index);
      jumpToHit(index >= 0 ? hits[index] : focus); // past the search's newest matches: by time, as the history jump
      return;
    }
    if (!hits.length || jumpedFor.current === searchRequest) return; // the focused jump above was this request's
    setActiveResult(0);
    jumpToHit(hits[0]);
  }, [searchResult, searchRequest, m.searchBusy, agentId, hits, jumpToHit, focus]);
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
