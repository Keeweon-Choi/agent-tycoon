import { useEffect, useState } from 'react';

import type { DeviceApprovalRequest } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { getLanguage, t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { ago, authFetch, networkLabel } from './authApi.js';

type Answer = 'approved' | 'refused' | 'wrong-code' | 'gone';

/**
 * New-device approval (T-0022, only with --allow-approval-requests). The
 * request names where it came from; approving needs the 6-digit code TYPED
 * from the new device's screen, and a request from the internet asks once
 * more. Pending requests come from GET /api/auth/approvals and the
 * deviceApprovalRequest/Closed messages.
 */
export function ApprovalDialog({ onDone }: { onDone: (text: string) => void }) {
  const [requests, setRequests] = useState<DeviceApprovalRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () =>
      authFetch<{ approvals: DeviceApprovalRequest[] }>('/api/auth/approvals').then(
        ({ approvals }) => setRequests(approvals),
        () => undefined,
      );
    void load();
    const offState = transport.onStateChange((state) => {
      if (state === 'connected') void load();
    });
    const offMessage = transport.onMessage((msg) => {
      if (msg.type === 'deviceApprovalRequest')
        setRequests((list) => [...list.filter((r) => r.id !== msg.id), msg]);
      else if (msg.type === 'deviceApprovalClosed')
        setRequests((list) => list.filter((r) => r.id !== msg.id));
    });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offState();
      offMessage();
      window.clearInterval(timer);
    };
  }, []);

  const request = requests.find((r) => r.expiresAt > now);
  if (!request) return null;
  return (
    <ApprovalModal
      key={request.id}
      request={request}
      now={now}
      onClose={(text) => {
        setRequests((list) => list.filter((r) => r.id !== request.id));
        if (text) onDone(text);
      }}
    />
  );
}

function ApprovalModal({
  request,
  now,
  onClose,
}: {
  request: DeviceApprovalRequest;
  now: number;
  onClose: (text?: string) => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const digits = code.replace(/\D/g, '');
  const fromInternet = request.network === 'funnel';

  const send = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      const { result } = await authFetch<{ result: Answer }>(`/api/auth/approvals/${request.id}`, {
        method: 'POST',
        body: approve ? { approve, code: digits } : { approve },
      });
      if (result === 'wrong-code') {
        setError(t('auth.wrongCode'));
        setConfirmPublic(false);
      } else
        onClose(
          result === 'approved'
            ? t('auth.approved', { name: request.label })
            : result === 'refused'
              ? t('auth.refused')
              : t('auth.requestGone'),
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const created = new Date(request.createdAt).toLocaleTimeString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Modal isOpen onClose={() => onClose()} title={t('auth.newLoginRequest')} zIndex={70}>
      <div className="px-10 pb-10 flex flex-col gap-8 max-w-[440px]" data-testid="approval-dialog">
        <p className="text-sm text-yellow-300 border-2 border-yellow-300 px-8 py-4">
          {t('auth.rejectUnknown')}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-12 gap-y-2 text-sm m-0">
          <dt className="text-text-muted">{t('auth.name')}</dt>
          <dd className="m-0 break-all">{request.label}</dd>
          <dt className="text-text-muted">{t('auth.device')}</dt>
          <dd className="m-0">{request.agent}</dd>
          <dt className="text-text-muted">{t('auth.where')}</dt>
          <dd className={`m-0 break-all ${fromInternet ? 'text-yellow-300' : ''}`}>
            {networkLabel(request.network)} · {request.ip}
          </dd>
          <dt className="text-text-muted">{t('auth.when')}</dt>
          <dd className="m-0">
            {created} ({ago(request.createdAt, now)})
          </dd>
        </dl>
        {confirmPublic ? (
          <>
            <p className="text-sm">
              {t('auth.internetConfirm')}
            </p>
            <div className="flex justify-end gap-8">
              <Button size="sm" variant="accent" disabled={busy} onClick={() => void send(true)}>
                {t('auth.yesApprove')}
              </Button>
              <Button size="sm" onClick={() => setConfirmPublic(false)} autoFocus>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <label className="text-sm" htmlFor="approval-code">
              {t('auth.sixDigitCode')}
            </label>
            <input
              id="approval-code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="bg-bg-dark border-2 border-border px-8 py-4 text-2xl tracking-[0.3em] text-center outline-none focus:border-accent-bright"
              placeholder="123 456"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-8">
              <Button
                size="sm"
                variant={digits.length === 6 ? 'accent' : 'disabled'}
                disabled={digits.length !== 6 || busy}
                onClick={() => (fromInternet ? setConfirmPublic(true) : void send(true))}
              >
                {t('auth.approve')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void send(false)}>
                {t('auth.reject')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
