import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { authFetch } from './authApi.js';
import {
  noticePhase,
  resultKey,
  showInstall,
  signatureLines,
  type UpdateView,
} from './updateView.js';

const DISMISSED = 'cld.update-result-dismissed';
/** A page left open asks again when it comes back to the foreground, at most this often (the daemon throttles its own check). */
const REFETCH_MS = 10 * 60_000;
/** While an install runs the daemon restarts: ask often, and for no longer than this. */
const POLL_MS = 3_000;
const POLL_FOR_MS = 3 * 60_000;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * P3a: "새 버전 X.Y.Z" with what changed, what keeps running, and what is (and is not) signed. The
 * 설치 button asks once more; a remote device is asked for its step-up by authFetch. Nothing here
 * polls while the page is hidden.
 */
export function UpdateNotice() {
  const [view, setView] = useState<UpdateView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => read(DISMISSED));

  const load = useCallback(async () => {
    try {
      const next = await authFetch<UpdateView>('/api/cld/update', { noStepUp: true });
      setView(next);
      setRestarting(false);
      return next;
    } catch {
      return null; // the daemon is restarting, or this is not an install that updates: nothing to say
    }
  }, []);

  useEffect(() => {
    void load();
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < REFETCH_MS) return;
      last = Date.now();
      void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const running = view?.install?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const until = Date.now() + POLL_FOR_MS;
    const timer = window.setInterval(() => {
      if (Date.now() > until) window.clearInterval(timer);
      else void load().then((next) => next === null && setRestarting(true));
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const phase = noticePhase(view, dismissed);
  if (!view || phase === 'none' || hidden) return null;

  const install = async () => {
    if (!view.available) return;
    setBusy(true);
    setError('');
    try {
      await authFetch('/api/cld/update/install', {
        method: 'POST',
        body: { version: view.available.version },
      });
      setConfirming(false);
      await load();
    } catch (err) {
      setConfirming(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const closeResult = () => {
    if (!view.install) return;
    const key = resultKey(view.install);
    try {
      localStorage.setItem(DISMISSED, key);
    } catch {
      /* private mode: it shows once more */
    }
    setDismissed(key);
  };

  const box =
    'fixed left-1/2 -translate-x-1/2 top-[calc(var(--cld-safe-top)+56px)] z-[70] pixel-panel px-12 py-8 text-sm w-[min(520px,calc(100vw-32px))] flex flex-col gap-6 max-h-[70vh] overflow-y-auto';
  if (phase === 'result' && view.install) {
    return (
      <div role="status" data-testid="update-result" className={box}>
        <span>{restarting ? t('update.restarting') : view.install.message}</span>
        {view.install.state !== 'running' && (
          <div className="flex gap-8">
            <Button size="sm" onClick={closeResult}>
              {t('common.close')}
            </Button>
          </div>
        )}
      </div>
    );
  }
  const a = view.available!;
  return (
    <div role="status" data-testid="update-notice" className={box}>
      <strong>{t('update.title', { version: a.version })}</strong>
      <span className="opacity-70">{t('update.current', { version: view.current ?? '?' })}</span>
      <div data-testid="update-notes">
        <div className="opacity-70">{t('update.notes')}</div>
        <div className="whitespace-pre-wrap break-words">
          {a.notes?.trim() || t('update.noNotes')}
        </div>
      </div>
      <ul className="m-0 pl-0 list-none flex flex-col gap-2" data-testid="update-signature">
        {signatureLines(view.signature).map((line) => (
          <li key={line.key} data-testid={line.key}>
            {line.tick ? '✔ ' : ''}
            {t(line.key)}
          </li>
        ))}
      </ul>
      <span data-testid="update-keeps">
        {t('update.keeps', {
          sessions: view.facts.sessions,
          jobs: view.facts.jobs,
          worktrees: view.facts.worktrees,
        })}
      </span>
      {view.terminalOnly && (
        <code className="break-all">{t('update.terminal', { command: view.command })}</code>
      )}
      {!view.canInstall && !view.terminalOnly && (
        <span className="opacity-70">{t('update.readOnly')}</span>
      )}
      {error && (
        <span className="text-red-400" data-testid="update-error">
          {error}
        </span>
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-8">
          <span>{t('update.confirm', { version: a.version })}</span>
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={() => void install()}
            data-testid="update-confirm"
          >
            {t('update.confirmYes')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            {t('stepup.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex gap-8">
          {showInstall(view) && (
            <Button
              size="sm"
              variant="accent"
              onClick={() => setConfirming(true)}
              data-testid="update-install"
            >
              {t('update.install')}
            </Button>
          )}
          <Button size="sm" onClick={() => setHidden(true)}>
            {t('update.later')}
          </Button>
        </div>
      )}
    </div>
  );
}
