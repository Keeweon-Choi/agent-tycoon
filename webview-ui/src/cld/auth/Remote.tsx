import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { getLanguage, t } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { authFetch, isHomeScreenApp, type Me, SECTION } from './authApi.js';
import { LOOPBACK } from './autoMove.js';

/** GET /api/cld/connector (T-0024), the parts the app shows. */
export interface ConnectorStatus {
  connector: 'local' | 'lan' | 'tailscale' | 'direct';
  /** The one address invitations carry (the direct one with its secret path). */
  canonicalUrl: string;
  lanUrl: string | null;
  direct: {
    enabled: boolean;
    url: string | null;
    certificate: { notAfter: number; renewAt: number } | null;
    ipChangedAt: number | null;
  } | null;
}

/** An IP change is news on the LAN for two weeks. */
const IP_NEWS_MS = 14 * 24 * 60 * 60 * 1000;
const DISMISSED = 'cld.remote-banner-dismissed';

/** This page is on the canonical address (origin and, for the direct one, its secret path). */
function onCanonical(canonical: string, here: Location = window.location): boolean {
  const url = new URL(canonical);
  return url.origin === here.origin && here.pathname.startsWith(url.pathname.replace(/\/?$/, '/'));
}

function dismissed(key: string): boolean {
  try {
    return localStorage.getItem(DISMISSED) === key;
  } catch {
    return false;
  }
}

/**
 * One line at the top when this page is not on the canonical address: a
 * different address is a different site to the browser (its own storage,
 * login and installed app). With a device key the device moves itself
 * (T-0034's move code); without one it gets the address to open. After the
 * public IP changed, LAN pages say so: devices outside can't follow by
 * themselves (no rendezvous), they reconnect once from the Wi-Fi.
 */
export function RemoteBanner({ me }: { me: Me }) {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  /** The public IP changed recently and this page is a LAN one (plain http). */
  const [ipNews, setIpNews] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    authFetch<ConnectorStatus>('/api/cld/connector').then(
      (loaded) => {
        const changedAt = loaded.direct?.ipChangedAt ?? null;
        setIpNews(
          changedAt !== null &&
            Date.now() - changedAt < IP_NEWS_MS &&
            window.location.protocol === 'http:',
        );
        setStatus(loaded);
      },
      () => undefined,
    );
  }, []);
  if (!status || hidden || LOOPBACK.test(window.location.hostname)) return null;
  const elsewhere = !onCanonical(status.canonicalUrl);
  if (!elsewhere && !ipNews) return null;
  const changedAt = status.direct?.ipChangedAt ?? null;
  const key = `${status.canonicalUrl}|${changedAt ?? ''}`;
  if (dismissed(key)) return null;
  const move = async () => {
    setError('');
    try {
      const { url } = await authFetch<{ url: string }>('/api/auth/move-code', { method: 'POST' });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div
      role="status"
      data-testid="remote-banner"
      className="fixed left-1/2 -translate-x-1/2 top-[calc(var(--cld-safe-top)+8px)] z-[70] pixel-panel px-12 py-8 text-sm w-[min(520px,calc(100vw-32px))] flex flex-col gap-6"
    >
      <span>
        {ipNews
          ? t('auth.ipChanged')
          : t('auth.nonCanonical', { host: window.location.host })}
      </span>
      {/* O5: an installed app stays at the address it came from; the move is its one tap. */}
      {me.autoMoveTo && me.deviceId && isHomeScreenApp() && (
        <span className="text-xs text-text-muted" data-testid="auto-move-app-note">
          {t('autoMove.homeScreen')}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-8">
        {me.deviceId ? (
          <Button size="sm" variant="accent" onClick={() => void move()}>
            {t('auth.moveToMain')}
          </Button>
        ) : (
          <a className="text-accent-text break-all" href={status.canonicalUrl}>
            {status.canonicalUrl}
          </a>
        )}
        <Button
          size="sm"
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED, key);
            } catch {
              /* private mode: it comes back next time */
            }
            setHidden(true);
          }}
        >
          {t('common.close')}
        </Button>
      </div>
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}

/**
 * "바깥 직접 연결" in the security panel: the address invitations carry
 * (logged-in devices only see it) and a new secret path. A new one locks out
 * every invitation, bookmark and installed app; this device follows it.
 */
export function RemoteSection() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    authFetch<ConnectorStatus>('/api/cld/connector').then(setStatus, () => undefined);
  }, []);
  const direct = status?.direct;
  if (!direct?.enabled || !direct.url) return null;
  const until = direct.certificate
    ? new Date(direct.certificate.notAfter).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', { hour12: false })
    : '';
  return (
    <section className={SECTION} data-testid="remote-section">
      <h3 className="text-base m-0">{t('auth.directTitle')}</h3>
      <p className="text-xs text-text-muted m-0">
        {t('auth.directInfo')}{until ? t('auth.certificateUntil', { date: until }) : ''}.
      </p>
      <code className="text-xs break-all">{direct.url}</code>
      <div className="flex flex-wrap gap-8">
        <Button size="sm" onClick={() => void writeClipboardText(direct.url ?? '').then(setCopied)}>
          {copied ? t('auth.addressCopied') : t('auth.copyAddress')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (
              !window.confirm(
                t('auth.rotateConfirm'),
              )
            )
              return;
            authFetch<{ url: string }>('/api/cld/connector/rotate', { method: 'POST' }).then(
              ({ url }) => {
                if (onCanonical(direct.url ?? '')) window.location.assign(url);
                else {
                  setStatus({ ...status, direct: { ...direct, url } } as ConnectorStatus);
                  setNote(t('auth.rotated'));
                }
              },
              (err: unknown) => setNote(err instanceof Error ? err.message : String(err)),
            );
          }}
        >
          {t('auth.rotate')}
        </Button>
      </div>
      {note && <p className="text-xs m-0">{note}</p>}
    </section>
  );
}
