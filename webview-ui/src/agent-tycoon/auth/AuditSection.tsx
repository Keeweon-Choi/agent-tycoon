import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { getLanguage, t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { type AuditRow, auditWhat, auditWho, mergeNewest } from './auditView.js';
import { authFetch, SECTION } from './authApi.js';

interface Page {
  lines: AuditRow[];
  total: number;
}

const when = (at: number) =>
  new Date(at).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * O3: 보안 기록. The newest 50 lines of the daemon's security record and, on
 * "더 보기", the next 50. `refresh` reloads from the top (an action just ran).
 */
export function AuditSection({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  /** What is loaded, and the record's size when it was last in step: the next pages count from there. */
  const loaded = useRef<{ rows: AuditRow[]; since: number }>({ rows: [], since: 0 });
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Closed until opened: the record is long, and most visits do not need it. */
  const [open, setOpen] = useState(false);

  /** The newest page: new lines go on top, pages the person already opened stay. */
  const sync = useCallback(() => {
    authFetch<Page>('/api/auth/audit', { noStepUp: true }).then(
      (page) => {
        loaded.current = mergeNewest(loaded.current.rows, loaded.current.since, page);
        setRows(loaded.current.rows);
        setTotal(page.total);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(() => {
    if (open) sync();
  }, [open, sync, refresh]);
  // A device came in while the panel is open: its line is already there.
  useEffect(
    () => (open ? transport.onMessage((msg) => msg.type === 'newDeviceLogin' && sync()) : undefined),
    [open, sync],
  );

  const more = () => {
    setBusy(true);
    authFetch<Page>(`/api/auth/audit?skip=${rows.length}&since=${loaded.current.since}`, { noStepUp: true })
      .then(
        (page) => {
          loaded.current = { ...loaded.current, rows: [...loaded.current.rows, ...page.lines] };
          setRows(loaded.current.rows);
          setTotal(page.total);
          setFailed(false);
        },
        () => setFailed(true),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className={SECTION} data-testid="audit">
      <button
        type="button"
        className="flex items-center gap-4 text-left text-base"
        aria-expanded={open}
        data-testid="audit-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="material-symbols-sharp" aria-hidden="true">
          {open ? 'expand_more' : 'chevron_right'}
        </span>
        {t('auth.audit.title')}
      </button>
      {open && (
        <>
          <p className="text-xs text-text-muted m-0">{t('auth.audit.info')}</p>
          {failed && <p className="text-xs text-red-400 m-0">{t('auth.audit.loadFailed')}</p>}
          {!failed && rows.length === 0 && (
            <p className="text-sm text-text-muted m-0">{t('auth.audit.empty')}</p>
          )}
          {rows.map((row, i) => (
            <div key={i} className="border-t border-border pt-6 min-w-0" data-testid="audit-row">
              <div className="text-sm break-words">{auditWhat(row, t)}</div>
              <div className="text-xs text-text-muted break-words">
                {when(row.at)}
                {auditWho(row, t) && ` · ${auditWho(row, t)}`}
              </div>
            </div>
          ))}
          {rows.length < total && (
            <Button size="sm" disabled={busy} onClick={more} data-testid="audit-more">
              {t('auth.audit.more')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
