import { useEffect } from 'react';

import { MESSENGER_SEARCH_ALL_DEBOUNCE_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { serverText } from '../serverText.js';
import {
  clearSearchAll,
  openMessenger,
  openRoomAt,
  requestSearchAll,
  useMessenger,
} from './messengerStore.js';
import { type MessengerProps, Mug, nextRequestId, SearchHitRow } from './parts.js';
import { searchAllQuery, searchAllRows } from './searchAllView.js';

/**
 * The list's "대화 내용" group: the conversations' text for the words in the find field, matches grouped by
 * conversation. The daemon is asked only once typing has paused, and a newer word cancels the older request.
 */
export function AllSearchResults({
  findText,
  getAppearance,
}: { findText: string } & Pick<MessengerProps, 'getAppearance'>) {
  const m = useMessenger();
  const query = searchAllQuery(findText);
  useEffect(() => {
    if (!query) {
      clearSearchAll();
      return;
    }
    const timer = window.setTimeout(() => {
      const requestId = nextRequestId();
      requestSearchAll(requestId);
      transport.send({ type: 'chatSearchAll', requestId, query });
    }, MESSENGER_SEARCH_ALL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => clearSearchAll, []);
  if (!query) return null;
  const state = m.searchAll;
  const busy = !state || state.busy;
  const result = state?.result;
  const rows = result ? searchAllRows(result.groups, m.contacts, m.rooms) : [];
  const error = result?.error ? serverText(result) : '';
  return (
    <section aria-label={t('msgSearchAll.results')} data-testid="search-all">
      <div className="msg-section text-xs">
        <h2>
          {t('msgSearchAll.title')}
          {rows.length > 0 && <span className="text-2xs">{rows.length}</span>}
        </h2>
      </div>
      {busy && (
        <p className="px-12 py-4 text-xs text-text-muted" data-testid="search-all-busy">
          {t('msgSearchAll.busy')}
        </p>
      )}
      {error && (
        <p role="alert" className="px-12 py-4 text-xs text-danger">
          {error}
        </p>
      )}
      {result && !busy && !error && !rows.length && (
        <p className="px-12 py-4 text-xs text-text-muted">{t('msgSearchAll.none')}</p>
      )}
      {rows.map((row) => (
        <div key={row.key} data-testid={`search-all-${row.key}`} className="mx-8 mb-6">
          <p className="flex items-center gap-8 px-4 py-4 min-w-0">
            {row.agentId !== undefined ? (
              <Mug agentId={row.agentId} getAppearance={getAppearance} />
            ) : (
              <span className="msg-file-tile size-34! text-sm" aria-hidden="true">
                #
              </span>
            )}
            <strong className="text-sm truncate min-w-0">{row.name}</strong>
          </p>
          <ul aria-label={t('msgSearchAll.open', { name: row.name })}>
            {row.hits.map((hit) => (
              <SearchHitRow
                key={hit.id}
                hit={hit}
                query={query}
                onClick={() =>
                  row.roomId !== undefined
                    ? openRoomAt(row.roomId, hit.id)
                    : openMessenger(row.agentId, { at: hit.at, id: hit.id, query })
                }
              />
            ))}
          </ul>
          {row.more && <p className="px-4 py-2 text-2xs text-text-muted">{t('msgSearchAll.more')}</p>}
        </div>
      ))}
      {result?.truncated && !busy && (
        <p className="px-12 py-4 text-xs text-text-muted" data-testid="search-all-cut">
          {t('msgSearchAll.cut')}
        </p>
      )}
    </section>
  );
}
