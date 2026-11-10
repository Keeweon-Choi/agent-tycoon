import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { authFetch, countdown, formatShortCode } from './authApi.js';

/**
 * S3: the page a QR logged in, in Safari, shows a fresh 2-minute single-use
 * code for the Home-Screen app (which keeps its own cookies). The code lives
 * in this component's state only: never stored, never broadcast.
 */
export function HandoffPrompt({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const issue = useCallback(() => {
    setError('');
    authFetch<{ code: string; expiresIn: number }>('/api/auth/handoff-code', { method: 'POST' }).then(
      ({ code: fresh, expiresIn }) => {
        setNow(Date.now());
        setCode({ code: fresh, expiresAt: Date.now() + expiresIn * 1000 });
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  useEffect(issue, [issue]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = code ? code.expiresAt - now : 0;
  return (
    <Modal isOpen onClose={onClose} title={t('auth.handoff.title')} zIndex={65}>
      <div className="px-10 pb-10 flex flex-col items-center gap-10 text-center max-w-[400px]" data-testid="handoff">
        <p className="text-sm text-text-muted m-0">{t('auth.handoff.steps')}</p>
        {code && left > 0 ? (
          <>
            <strong className="text-3xl tracking-[0.15em] text-accent-text whitespace-nowrap" data-testid="handoff-code">
              {formatShortCode(code.code)}
            </strong>
            <p className="text-sm m-0" aria-live="polite">{t('auth.codeExpires', { time: countdown(left) })}</p>
          </>
        ) : code ? (
          <>
            <p className="text-sm m-0">{t('auth.codeExpired')}</p>
            <Button size="sm" variant="accent" onClick={issue}>{t('auth.newCode')}</Button>
          </>
        ) : error ? (
          <p className="text-sm text-red-400 m-0">{t('auth.codeFailed', { error })}</p>
        ) : (
          <p className="text-sm text-text-muted m-0">{t('auth.creatingCode')}</p>
        )}
      </div>
    </Modal>
  );
}
