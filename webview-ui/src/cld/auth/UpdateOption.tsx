import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { timeAgo } from '../format.js';
import { SettingRow } from '../SettingRow.js';
import { authFetch } from './authApi.js';
import type { UpdateView } from './updateView.js';

/**
 * 설정 › 일반: this daemon's version, the last update check (when, and why it failed) and 지금 확인
 * (POST /api/cld/update/check, once a minute). A source install says its updates come from the checkout.
 */
export function UpdateOption() {
  const [view, setView] = useState<UpdateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    authFetch<UpdateView>('/api/cld/update', { noStepUp: true }).then(setView, () => undefined);
  }, []);
  if (!view) return null;

  const checkNow = async () => {
    setBusy(true);
    setError('');
    try {
      setView(
        await authFetch<UpdateView>('/api/cld/update/check', { method: 'POST', noStepUp: true }),
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 429
          ? t('update.check.throttled')
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const last = view.lastCheck;
  const lines = !view.managed
    ? [t('update.check.source')]
    : [
        t('update.current', { version: view.current ?? '?' }),
        !last
          ? t('update.check.never')
          : last.ok
            ? t('update.check.ok', { when: timeAgo(new Date(last.at).toISOString()) })
            : t('update.check.failed', {
                when: timeAgo(new Date(last.at).toISOString()),
                reason: last.reason ?? '?',
              }),
        ...(view.available ? [t('update.title', { version: view.available.version })] : []),
      ];
  return (
    <SettingRow
      testId="update-option"
      title={t('update.check.title')}
      help={t('update.check.help')}
      note={
        <div className="space-y-2 pl-8 pr-8 pb-4 text-sm text-text-muted">
          {lines.map((line, i) => (
            <p
              key={i}
              className={`m-0 break-words ${last && !last.ok && i === 1 ? 'text-danger' : ''}`}
            >
              {line}
            </p>
          ))}
          {error && (
            <p className="m-0 text-danger" role="alert" data-testid="update-check-error">
              {error}
            </p>
          )}
        </div>
      }
    >
      {view.managed && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void checkNow()}
          data-testid="update-check-now"
        >
          {t('update.check.now')}
        </Button>
      )}
    </SettingRow>
  );
}
