import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { authFetch, countdown, formatShortCode } from './authApi.js';
import { afterCancel, canShareLink, inviteButtons, invitePhase, shareLink, suggestedNickname } from './inviteView.js';
import { QrCode } from './QrCode.js';
import { Relogin } from './Relogin.js';

interface DeviceCode {
  code: string;
  /** Where the new device opens it: the canonical address. */
  url: string;
  /** The QR: that address with the code. */
  link: string;
  expiresAt: number;
}

/** "기기 추가" (T-0022): an 8-digit code to type on the new device and a QR of
 *  a login link; one credential, 5 minutes. Works from anywhere (T-0034): the
 *  address shown and copied is the canonical one. */
export function AddDeviceButton({ targetUrl, label, zIndex = 60 }: { targetUrl?: string; label?: string; zIndex?: number } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
        {label ?? t('auth.addDevice')}
      </Button>
      {open && (
        <AddDeviceModal onClose={() => setOpen(false)} targetUrl={targetUrl} zIndex={zIndex} />
      )}
    </>
  );
}

/** What status, cancel and nickname ask by: the invitation's id on the host, never the code. */
interface Invite extends DeviceCode {
  id: string;
}

interface Registered {
  /** What the host recorded: "Windows · Chrome". */
  label: string;
  nickname?: string;
}

/** How often the inviting screen asks whether the code was used. */
const INVITE_POLL_MS = 2000;

function AddDeviceModal({ onClose, targetUrl, zIndex }: { onClose: () => void; targetUrl?: string; zIndex: number }) {
  const [code, setCode] = useState<Invite | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [notice, setNotice] = useState('');
  const [registered, setRegistered] = useState<Registered | null>(null);
  const [watchStopped, setWatchStopped] = useState(false);
  const [nickname, setNickname] = useState('');
  const [nicknameNote, setNicknameNote] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const issue = useCallback(() => {
    setError('');
    setCancelled(false);
    setNotice('');
    setRegistered(null);
    setWatchStopped(false);
    setLinkCopied(false);
    authFetch<{ code: string; url: string; link: string; expiresIn: number; id: string }>(
      '/api/auth/device-code',
      { method: 'POST' },
    ).then(
      ({ code, url, link, expiresIn, id }) => {
        setNow(Date.now());
        const destination = targetUrl ?? url;
        const codeInLink = new URL(link).searchParams.get('code');
        const outsideLink = codeInLink ? new URL(`login?code=${encodeURIComponent(codeInLink)}`, destination).href : link;
        setCode({ code, id, url: destination, link: outsideLink, expiresAt: Date.now() + expiresIn * 1000 });
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [targetUrl]);

  useEffect(issue, [issue]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const left = code ? code.expiresAt - now : 0;
  const phase = invitePhase({ hasCode: !!code, error: !!error, cancelled, registered: !!registered, msLeft: left });
  const buttons = inviteButtons(phase, canShareLink(navigator));

  // While the code can still be used, ask the host every 2 s whether it was.
  const watching = !!code && phase === 'active' && !watchStopped;
  const inviteId = code?.id;
  useEffect(() => {
    if (!watching || !inviteId) return;
    let busy = false;
    let live = true;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      authFetch<{ state: string; device?: Registered }>(`/api/auth/device-invite/${encodeURIComponent(inviteId)}`, { noStepUp: true }).then(
        (status) => {
          if (!live) return;
          if (status.state === 'registered' && status.device) {
            setRegistered(status.device);
            setNickname(suggestedNickname(status.device.label));
          } else if (status.state === 'cancelled') setCancelled(true);
        },
        () => live && setWatchStopped(true),
      ).finally(() => {
        busy = false;
      });
    }, INVITE_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [watching, inviteId]);

  const cancelInvite = () => {
    if (!code) return;
    setNotice('');
    authFetch<{ state?: string; device?: Registered }>(`/api/auth/device-invite/${encodeURIComponent(code.id)}/cancel`, { method: 'POST', noStepUp: true }).then(
      (answer) => {
        const after = afterCancel(answer);
        if (after.kind === 'registered') {
          setRegistered(after.device);
          setNickname(suggestedNickname(after.device.label));
        } else setCancelled(true);
      },
      (err: unknown) => setNotice(t('auth.inviteCancelFailed', { error: err instanceof Error ? err.message : String(err) })),
    );
  };
  const saveNickname = () => {
    if (!code) return;
    setNicknameNote('');
    authFetch<{ name: string }>(`/api/auth/device-invite/${encodeURIComponent(code.id)}/nickname`, {
      method: 'POST',
      body: { name: nickname },
    }).then(
      ({ name }) => {
        setRegistered((r) => r && { ...r, nickname: name });
        setNicknameNote(t('auth.inviteNicknameSaved'));
      },
      (err: unknown) => setNicknameNote(t('auth.inviteNicknameFailed', { error: err instanceof Error ? err.message : String(err) })),
    );
  };

  return (
    <Modal isOpen onClose={onClose} title={t('auth.addDevice')} zIndex={zIndex}>
      <div
        className="px-10 pb-10 flex flex-col items-center gap-10 text-center"
        data-testid="add-device"
      >
        {phase === 'active' && code ? (
          <>
            <p className="text-sm text-text-muted">
              {t('auth.openAndEnter', { url: code.url })}
            </p>
            <Button size="sm" onClick={() => void writeClipboardText(code.url).then(setCopied)}>
              {copied ? t('auth.addressCopied') : t('auth.copyAddress')}
            </Button>
            <strong
              className="text-3xl tracking-[0.15em] text-accent-text whitespace-nowrap"
              data-testid="device-code"
            >
              {formatShortCode(code.code)}
            </strong>
            <QrCode text={code.link} />
            <p className="text-xs text-text-muted">{t('auth.phoneQr')}</p>
            <div className="flex flex-wrap justify-center gap-6">
              {buttons.copyLink && (
                <Button size="sm" onClick={() => void writeClipboardText(code.link).then(setLinkCopied)}>
                  {linkCopied ? t('auth.linkCopied') : t('auth.copyLink')}
                </Button>
              )}
              {buttons.share && (
                <Button size="sm" onClick={() => void shareLink(navigator, t('auth.shareText'), code.link)}>
                  {t('auth.share')}
                </Button>
              )}
              {buttons.cancel && (
                <Button size="sm" onClick={cancelInvite}>
                  {t('auth.cancelInvite')}
                </Button>
              )}
            </div>
            {notice && <p className="text-xs text-red-400" role="alert">{notice}</p>}
            {buttons.closeNote && <p className="text-xs text-text-muted">{t('auth.inviteCloseKeeps')}</p>}
            <p className="text-sm" aria-live="polite">
              {t('auth.codeExpires', { time: countdown(left) })}
            </p>
            {watchStopped && (
              <p className="text-xs text-text-muted">
                {t('auth.inviteWatchStopped')}{' '}
                <button type="button" className="underline" onClick={() => setWatchStopped(false)}>
                  {t('auth.inviteRecheck')}
                </button>
              </p>
            )}
          </>
        ) : phase === 'registered' && registered ? (
          <>
            <p className="text-sm" data-testid="invite-registered" aria-live="polite">
              {registered.nickname
                ? t('auth.inviteRegisteredNamed', { name: registered.nickname, device: registered.label })
                : t('auth.inviteRegistered', { device: registered.label })}
            </p>
            <form
              className="flex items-center gap-6"
              onSubmit={(event) => {
                event.preventDefault();
                saveNickname();
              }}
            >
              <input
                className="border border-border bg-bg px-6 py-2 text-sm text-text"
                aria-label={t('auth.inviteNickname')}
                data-testid="invite-nickname"
                value={nickname}
                maxLength={40}
                onChange={(event) => setNickname(event.target.value)}
              />
              <Button size="sm" variant="accent" type="submit" disabled={!nickname.trim()}>
                {t('auth.inviteNicknameSave')}
              </Button>
            </form>
            {nicknameNote && <p className="text-xs text-text-muted" aria-live="polite">{nicknameNote}</p>}
            <Button size="sm" onClick={issue}>
              {t('auth.createNewCode')}
            </Button>
          </>
        ) : phase === 'cancelled' ? (
          <>
            <p className="text-sm">{t('auth.inviteCancelled')}</p>
            <Button size="sm" variant="accent" onClick={issue}>
              {t('auth.createNewCode')}
            </Button>
          </>
        ) : phase === 'expired' ? (
          <>
            <p className="text-sm">{t('auth.codeExpired')}</p>
            <Button size="sm" variant="accent" onClick={issue}>
              {t('auth.newCode')}
            </Button>
          </>
        ) : phase === 'failed' ? (
          <>
            <p className="text-sm text-red-400">{t('auth.codeFailed', { error })}</p>
            <Relogin note={error} />
            <Button size="sm" onClick={issue}>
              {t('auth.retry')}
            </Button>
          </>
        ) : (
          <p className="text-sm text-text-muted">{t('auth.creatingCode')}</p>
        )}
      </div>
    </Modal>
  );
}

/** Show a fresh invitation directly beside a verified outside address. */
export function OutsideDeviceInvite({ targetUrl }: { targetUrl: string }) {
  const [invite, setInvite] = useState<DeviceCode | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const issue = useCallback(() => {
    setError('');
    authFetch<{ code: string; link: string; expiresIn: number }>('/api/auth/device-code', { method: 'POST' }).then(
      ({ code, link, expiresIn }) => {
        const linkCode = new URL(link).searchParams.get('code');
        if (!linkCode) { setError(t('auth.qrFailed')); return; }
        setInvite({ code, url: targetUrl, link: new URL(`login?code=${encodeURIComponent(linkCode)}`, targetUrl).href,
          expiresAt: Date.now() + expiresIn * 1000 });
        setNow(Date.now());
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [targetUrl]);
  useEffect(issue, [issue]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = invite ? invite.expiresAt - now : 0;
  return <div className="flex flex-col gap-4 items-start" data-testid="outside-device-invite">
    <p className="m-0 text-xs">{t('auth.newPhoneQr')}</p>
    {invite && left > 0 ? <>
      <strong className="text-xl tracking-[0.15em] text-accent-text">{formatShortCode(invite.code)}</strong>
      <QrCode text={invite.link} size={160} />
      <p className="m-0 text-xs text-text-muted">{t('auth.codeExpires', { time: countdown(left) })}</p>
    </> : <Button size="sm" onClick={issue}>{invite ? t('auth.createNewCode') : t('auth.createQrAgain')}</Button>}
    {error && <p className="m-0 text-xs text-red-400">{error}</p>}
    <Relogin note={error} />
  </div>;
}
