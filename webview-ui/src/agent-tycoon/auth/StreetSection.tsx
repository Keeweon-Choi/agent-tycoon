import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { ago, authFetch, countdown, formatShortCode, passkeyError, SECTION } from './authApi.js';

/** GET /api/street (MHO v1b): who this host reads, and who reads it. Never a token. */
interface StreetLists {
  neighbours: Array<{ hostId: string; name: string; url: string; pairedAt: number }>;
  readers: Array<{ hostId: string; name: string; pairedAt: number; lastSeen: number | null }>;
}

/**
 * 보안 > 옆 건물 (MHO v1b, ADR-0020), minimal until the street itself is drawn: on this host, a
 * pair code for another PC (a fresh step-up) and the PCs that read this one (deleting one revokes
 * it at once); and the PCs this one reads, added by their https address and the code got there.
 */
export function StreetSection() {
  const [lists, setLists] = useState<StreetLists | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [url, setUrl] = useState('');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A daemon without the street answers 404: no section.
  const load = useCallback(() => {
    authFetch<StreetLists>('/api/street').then(setLists, () => setLists(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNote('');
    try {
      await what();
      setNote(done);
    } catch (err) {
      setNote(passkeyError(err));
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!lists) return null;
  const left = code ? code.expiresAt - now : 0;
  return (
    <section className={SECTION} data-testid="street-section">
      <h3 className="text-base m-0">{t('street.title')}</h3>
      <p className="text-xs text-text-muted m-0">{t('street.help')}</p>

      {lists.readers.map((r) => (
        <div key={r.hostId} className="flex items-center gap-8 border-t border-border pt-6" data-testid="street-reader">
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{t('street.readerRow', { name: r.name })}</div>
            <div className="text-xs text-text-muted">
              {r.lastSeen === null ? t('street.notReadYet') : t('auth.lastSeen', { time: ago(r.lastSeen) })}
            </div>
          </div>
          <Button size="sm" disabled={busy} onClick={() => void run(() => authFetch(`/api/street/readers/${encodeURIComponent(r.hostId)}`, { method: 'DELETE' }), t('street.readerDeleted'))}>
            {t('street.delete')}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-8">
        <Button
          size="sm"
          disabled={busy}
          data-testid="street-pair-code"
          onClick={() =>
            void run(async () => {
              const issued = await authFetch<{ code: string; expiresIn: number }>('/api/street/pair-code', { method: 'POST' });
              setNow(Date.now());
              setCode({ code: issued.code, expiresAt: Date.now() + issued.expiresIn * 1000 });
            }, '')
          }
        >
          {t('street.pairCode')}
        </Button>
        {code && left > 0 && (
          <span className="text-sm" data-testid="street-code">
            <strong className="text-accent-text tracking-[0.15em]">{formatShortCode(code.code)}</strong>{' '}
            {t('street.codeLeft', { time: countdown(left) })}
          </span>
        )}
      </div>

      {lists.neighbours.map((n) => (
        <div key={n.hostId} className="flex items-center gap-8 border-t border-border pt-6" data-testid="street-neighbour">
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{n.name}</div>
            <div className="text-xs text-text-muted truncate" title={n.url}>{n.url}</div>
          </div>
          <Button size="sm" disabled={busy} onClick={() => void run(() => authFetch(`/api/street/neighbours/${encodeURIComponent(n.hostId)}`, { method: 'DELETE' }), t('street.neighbourRemoved'))}>
            {t('street.remove')}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-6 border-t border-border pt-6">
        <input
          aria-label={t('street.urlLabel')}
          placeholder="https://"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1 bg-bg-dark border border-border p-4 text-xs"
          data-testid="street-url"
        />
        <input
          aria-label={t('street.codeLabel')}
          inputMode="numeric"
          maxLength={9}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-[8em] bg-bg-dark border border-border p-4 text-xs"
          data-testid="street-code-input"
        />
        <Button
          size="sm"
          variant="accent"
          disabled={busy || !url.trim() || !typed.trim()}
          data-testid="street-add"
          onClick={() =>
            void run(async () => {
              await authFetch('/api/street/neighbours', { method: 'POST', body: { url: url.trim(), code: typed } });
              setUrl('');
              setTyped('');
            }, t('street.added'))
          }
        >
          {t('street.add')}
        </Button>
      </div>
      {url.trim().toLowerCase().startsWith('http://') && <p className="m-0 text-xs text-red-400">{t('srv.street_https_only')}</p>}
      {note && <p className="m-0 text-xs" role="status">{note}</p>}
    </section>
  );
}
